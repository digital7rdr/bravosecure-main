import React, {useState, useRef, useEffect, useMemo, useCallback} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  FlatList,
  TouchableOpacity,
  Animated,
  Modal,
  Pressable,
  StatusBar,
  Linking,
  type DimensionValue,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import WebView, {type WebViewMessageEvent} from 'react-native-webview';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import {useIntelFeed, type WireFilter as FeedFilter, type IntelItem} from '@/modules/news/useIntelFeed';
import {NEWS_CATEGORIES, categoryLabel, loadNewsPrefs} from '@modules/news/newsPrefs';
import {matchesAnyCategory} from '@/modules/news/intelAggregator';
import {clusterKey, clusterMarkers, type MapMarker} from '@/modules/news/mapbox';
import {buildBravoMapHtml} from '@/modules/news/bravoMapHtml';
import {MAPBOX_TOKEN} from '@/modules/maps/mapToken';
import {useMapReload} from '@/modules/maps/useMapReload';
import {MapFailedOverlay} from '@/modules/maps/MapFailedOverlay';
import LoadingView from '@components/LoadingView';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {ShareNewsSheet, type ShareableNews} from '@/modules/news/ShareNewsSheet';

// ── Types ──────────────────────────────────────────────────────────────────
type IntelTab = 'map' | 'wire' | 'signals';
type WireFilter = FeedFilter;

/** Narrow a saved pref id (plain string) to a chip. */
function isWireFilter(id: string): id is WireFilter {
  return NEWS_CATEGORIES.some(c => c.id === id);
}
type WireItem = IntelItem;

interface Signal {
  name: string;
  region: string;
  value: number;
  color: string;
  sectionBg: string;
  sectionBorder: string;
}


// Why: hoisted so the WebView `source` prop stays referentially stable across
// renders. ⚠️ LOAD-BEARING — inlining this re-runs `buildBravoMapHtml()` and
// re-marshals a ~10 KB string across JSI on every render. (It does NOT prevent a
// per-render map reload; Fabric diffs `source` by value either way.)
const MAP_SOURCE = {html: buildBravoMapHtml(MAPBOX_TOKEN)};

/**
 * B-656 — hard ceiling on how many markers reach the map WebView.
 * See the `threatsJs` memo for why this is capped at the render boundary and
 * why 30 (it matches the sibling static-map path's convention).
 */
const MAX_MAP_MARKERS = 30;

/**
 * B-656 — the live UTC clock, isolated so its 1 Hz tick re-renders ONE `<Text>`
 * instead of the whole 805-line screen.
 *
 * ⚠️ Read this before "simplifying" it back into the parent. The state itself
 * was cheap — a prior audit (docs/audits/MAPBOX_AUDIT.md:176) correctly graded
 * it "cheap but pointless churn". What made it worth extracting is what the
 * re-render TOUCHED: the 220-view scanline overlay, the ticker's `Animated.View`
 * children array (a fresh array every render defeats RN's AnimatedProps memo,
 * which retains arrays by reference — so the marquee's native animation was
 * torn down and re-attached once per second), and the WebView's `onMessage`
 * identity (which re-subscribed two native event listeners every tick).
 *
 * This is a GLITCH fix, not the cure for this screen's lag. Do not report it as
 * one — see docs/audits/INTEL_FEED_LAG_AUDIT_2026-08-24.md.
 */
function utcNow(): string {
  const n = new Date();
  return `${n.getUTCHours().toString().padStart(2, '0')}:${n.getUTCMinutes().toString().padStart(2, '0')}:${n.getUTCSeconds().toString().padStart(2, '0')}`;
}

const UtcClock = React.memo(function UtcClock() {
  const [t, setT] = useState(utcNow);
  useEffect(() => {
    const id = setInterval(() => setT(utcNow()), 1000);
    return () => clearInterval(id);
  }, []);
  return <Text style={styles.clock}>{t} UTC</Text>;
});

// ── Signals data ────────────────────────────────────────────────────────────
const SIGNALS_CRITICAL: Signal[] = [
  {name:'Red Sea Corridor', region:'MARITIME · MILITARY', value:92, color:'#FF3B30', sectionBg:'rgba(255,59,48,0.04)', sectionBorder:'rgba(255,59,48,0.3)'},
  {name:'Sudan-Chad Border', region:'GROUND · ARMED', value:88, color:'#FF3B30', sectionBg:'rgba(255,59,48,0.04)', sectionBorder:'rgba(255,59,48,0.3)'},
  {name:'UAE Cyber Grid', region:'CYBER · INFRASTRUCTURE', value:79, color:'#FF3B30', sectionBg:'rgba(255,59,48,0.03)', sectionBorder:'rgba(255,59,48,0.25)'},
];
const SIGNALS_HIGH: Signal[] = [
  {name:'Riyadh Protest Zone', region:'CIVIL · POLITICAL', value:64, color:'#FFB800', sectionBg:'transparent', sectionBorder:'rgba(255,184,0,0.25)'},
  {name:'Arabian Sea Ops', region:'NAVAL · EXERCISES', value:58, color:'#FFB800', sectionBg:'transparent', sectionBorder:'rgba(255,184,0,0.2)'},
];
const SIGNALS_MEDIUM: Signal[] = [
  {name:'Moscow Tensions', region:'DIPLOMATIC · POLITICAL', value:45, color:'#60A5FA', sectionBg:'transparent', sectionBorder:'#1E2D45'},
  {name:'London Finance', region:'ECONOMIC · TRADE', value:32, color:'#60A5FA', sectionBg:'transparent', sectionBorder:'#1E2D45'},
  {name:'Singapore Maritime', region:'TRADE · SHIPPING', value:24, color:'#2563EB', sectionBg:'transparent', sectionBorder:'#1E2D45'},
];

// ── Ticker fallback — used only when no live items have loaded yet ─────────
const TICKER_FALLBACK = [
  {color: '#1E88FF', text: 'CONNECTING · Live intel stream initialising'},
];

function tickerTextFor(item: IntelItem): string {
  const prefix = item.priority === 'CRITICAL' ? 'CRIT'
               : item.priority === 'HIGH'     ? 'HIGH'
               : item.priority === 'MEDIUM'   ? 'MED'  : 'LOW';
  // Trim so the ticker row stays on one line on small phones.
  const short = item.headline.length > 90 ? `${item.headline.slice(0, 90)}…` : item.headline;
  return `${prefix} · ${short}`;
}

/**
 * B-656 — one wire row, memoised.
 *
 * `onPress` takes the ITEM and is a `useCallback` in the parent, so this memo
 * actually bails: the row's two props (`item`, `onPress`) are both stable
 * across a parent re-render. The previous inline `onPress={() => openDrawer(item)}`
 * would have defeated it on every render even if the row had been memoised.
 */
const WireRow = React.memo(function WireRow({
  item, onPress,
}: {item: WireItem; onPress: (item: WireItem) => void}) {
  return (
    <TouchableOpacity
      style={[styles.wireItem, {borderLeftColor: item.priorityColor}]}
      onPress={() => onPress(item)}
      activeOpacity={0.8}>
      <View style={styles.itemMeta}>
        <Text style={styles.itemCode}>{item.id}</Text>
        <View style={[styles.itemBadge, {backgroundColor: item.priorityBg, borderColor: item.priorityColor + '44'}]}>
          <Text style={[styles.itemBadgeText, {color: item.priorityColor}]}>{item.priority}</Text>
        </View>
        <View style={[styles.itemBadge, {backgroundColor: 'rgba(37,99,235,0.04)', borderColor: '#1E2D45'}]}>
          <Text style={[styles.itemBadgeText, {color: '#64748B'}]}>{item.tag}</Text>
        </View>
        <Text style={styles.itemTs}>{item.ts}</Text>
      </View>
      <Text style={styles.itemHeadline}>{item.headline}</Text>
      <View style={styles.itemFooter}>
        <Text style={styles.itemLoc}>{item.loc}</Text>
        <Text style={styles.itemSrc}>{item.src}</Text>
      </View>
    </TouchableOpacity>
  );
});

/** B-656 — module-level so FlatList sees a stable `keyExtractor` identity. */
const wireKeyExtractor = (i: WireItem): string => i.id;

/** B-656 — module-level: a fresh closure here re-renders the map's loading overlay. */
const renderMapLoading = () => (
  <View style={styles.mapLoadingOverlay}>
    <LoadingView compact />
    <Text style={styles.mapLoadingText}>BOOTING BRAVO MAP…</Text>
  </View>
);

// ── Component ───────────────────────────────────────────────────────────────
export default function IntelFeedScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const [activeTab, setActiveTab] = useState<IntelTab>('map');
  const [wireFilter, setWireFilter] = useState<WireFilter>('ALL');
  const [drawerItem, setDrawerItem] = useState<WireItem | null>(null);
  // Region-cluster drawer: every headline under the tapped bubble, swipeable.
  // Null for single-item (wire row) opens — the drawer then renders one card.
  const [drawerHits, setDrawerHits] = useState<WireItem[] | null>(null);
  const [drawerIndex, setDrawerIndex] = useState(0);
  const [pagerW, setPagerW] = useState(0);
  // Why: once the map tab has been visited we keep the WebView mounted (hidden)
  // so tab switches don't re-boot Leaflet + refetch the CDN basemap.
  const [mapVisited, setMapVisited] = useState(false);
  useEffect(() => {
    if (activeTab === 'map' && !mapVisited) {setMapVisited(true);}
  }, [activeTab, mapVisited]);

  // Live Guardian feed (refetches on filter change). `items` already
  // carries pre-computed priorityColor/bg + geotag lat/lng so the
  // renderers below stay pure.
  const {items, mapExtras, loading, error, refresh} = useIntelFeed(wireFilter);

  // Founder 2026-08-09 — the News Filter selection drives THIS feed too, not
  // just My Feed. The saved categories both (a) choose which chips appear, so
  // the strip shows what the user actually subscribed to, and (b) gate the ALL
  // pool. No saved selection = no preference: every chip, everything through.
  const [savedCats, setSavedCats] = useState<WireFilter[]>([]);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void loadNewsPrefs().then(p => {
        if (cancelled) {return;}
        setSavedCats(p.categories.filter(isWireFilter));
      });
      return () => { cancelled = true; };
    }, []),
  );
  // ALL + the subscribed categories, in the News Filter's own order so the two
  // screens read identically.
  const chips = useMemo<WireFilter[]>(() => {
    const subscribed = NEWS_CATEGORIES.map(c => c.id).filter(id => savedCats.includes(id));
    return ['ALL', ...(subscribed.length ? subscribed : NEWS_CATEGORIES.map(c => c.id))];
  }, [savedCats]);
  // Chip labels come from the same table as the News Filter screen.
  const chipLabel = useCallback(
    (f: WireFilter) => (f === 'ALL' ? 'ALL' : categoryLabel(f).toUpperCase()),
    [],
  );
  // A saved selection that no longer includes the active chip would strand the
  // user on an empty list — fall back to ALL.
  useEffect(() => {
    if (wireFilter !== 'ALL' && !chips.includes(wireFilter)) {setWireFilter('ALL');}
  }, [chips, wireFilter]);
  // The MAP plots the wire items PLUS the worldwide sweep (every continent,
  // category-scoped). The wire list below stays `items` only.
  const mapItems = useMemo(() => [...items, ...mapExtras], [items, mapExtras]);

  // Leaflet WebView bridge — we own the native RN chrome (nav/tabs/
  // stats/ticker) and the WebView owns just the map canvas. Markers
  // are pushed in whenever the intel feed refreshes via
  // `window.updateThreats([...])`.
  const mapWebViewRef = useRef<WebView>(null);
  const mapReady      = useRef(false);
  // B-89 MG-10 — watchdog + remount recovery (same machinery as the GL maps).
  const mapHealth     = useMapReload();

  const mapMarkers = useMemo<MapMarker[]>(
    () => mapItems
      .filter(i => typeof i.lat === 'number' && typeof i.lng === 'number')
      .map(i => ({lng: i.lng!, lat: i.lat!, severity: i.priority, label: i.loc.replace('📍 ', '')})),
    [mapItems],
  );
  const clusters = useMemo(() => clusterMarkers(mapMarkers), [mapMarkers]);

  // Serialise the current clusters as the JS the WebView should run.
  // Using a ref + an effect keeps the bridge idempotent — if the WebView
  // signals `ready` after our first render we flush whatever we have.
  /**
   * B-656 — the payload is CAPPED, and capped HERE rather than upstream.
   *
   * Every marker the WebView renders costs 7 DOM nodes, one `infinite` CSS
   * radar animation and one `backdrop-filter` badge, composited over a live
   * WebGL globe — forever. Nothing bounded that count: `selectWorldExtras`
   * returns the world sweep uncapped (a 53-country spread), so the marker set
   * grows with news volume without limit. The sibling static-map path already
   * chose 30 (`mapbox.ts`), though for an unrelated reason (a URL byte limit),
   * so the number is a convention here, not a measured budget.
   *
   * ⚠️ CAPPED AT THE RENDER BOUNDARY, NOT ON `clusters`. `clusters` also feeds
   * the LOCATED stat and `regionHits`; slicing it would make a bubble read "2"
   * while its drawer listed 5 — the exact count-mismatch class fixed on
   * 2026-07-31. Only what we hand the WebView is trimmed.
   *
   * Severity-sorted so the cap drops the LEAST severe first — a CRITICAL
   * marker must never be the one culled.
   */
  const threatsJs = useMemo(() => {
    const rank: Record<string, number> = {CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3};
    const data = [...clusters]
      .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || b.count - a.count)
      .slice(0, MAX_MAP_MARKERS)
      .map(c => ({
        lat:      c.lat,
        lng:      c.lng,
        severity: c.severity,
        count:    c.count,
        label:    c.label,
      }));
    return `window.updateThreats && window.updateThreats(${JSON.stringify(data)}); true;`;
  }, [clusters]);

  useEffect(() => {
    if (mapReady.current) {mapWebViewRef.current?.injectJavaScript(threatsJs);}
  }, [threatsJs]);

  /**
   * B-656 — idle the map whenever it is not the visible tab.
   *
   * The WebView is deliberately kept MOUNTED at `opacity: 0` when the user is
   * on Wire/Signals, so a tab switch does not re-boot the map and refetch the
   * basemap. But `opacity` on the RN parent does not change the page's
   * `document.visibilityState`, so Chromium never throttles it — every
   * marker's `infinite` radar animation kept compositing at full cost behind a
   * surface nobody could see. With the camera at rest that animation is the
   * ONLY frame source in the page, so pausing it takes a hidden map to zero.
   *
   * Unobservable by construction: it only ever applies while the surface is
   * fully transparent. `mapReady` gates it because injecting before the page
   * has booted is a no-op that would be silently lost — the `'ready'` handler
   * re-applies it below.
   */
  const mapActive = activeTab === 'map';
  useEffect(() => {
    if (!mapReady.current) {return;}
    mapWebViewRef.current?.injectJavaScript(
      `window.setMapActive && window.setMapActive(${mapActive}); true;`,
    );
  }, [mapActive]);

  const handleMapMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as {type: string; payload?: {lat?: number; lng?: number; label?: string}};
      if (msg.type === 'ready') {
        mapReady.current = true;
        mapHealth.onReady();
        mapWebViewRef.current?.injectJavaScript(threatsJs);
        // B-656 — re-apply the idle state on boot. The effect that drives it is
        // gated on `mapReady`, so a page that finishes loading while the user is
        // already on another tab would otherwise come up ANIMATING behind a
        // transparent surface — the exact state this is meant to prevent.
        mapWebViewRef.current?.injectJavaScript(
          `window.setMapActive && window.setMapActive(${activeTab === 'map'}); true;`,
        );
        return;
      }
      /**
       * B-656 — a FATAL pre-load failure must reach the watchdog.
       *
       * `useMapReload` exports `onError` for exactly this and nothing called
       * it, so `gl-unsupported` (and a throwing map constructor) were parsed
       * and dropped on the floor. The user then stared at a blank map for the
       * FULL 15 s watchdog timeout before recovery was even attempted — which
       * on a device without WebGL reads as "the map is broken".
       *
       * ⚠️ Only PRE-LOAD errors are fatal. Mapbox GL fires `error` for
       * recoverable tile 404s too, so once the map has reported `ready` these
       * are ignored deliberately — escalating them would reload a working map
       * every time a single tile failed on a flaky connection.
       */
      if (msg.type === 'error' && !mapReady.current) {
        mapHealth.onError();
        return;
      }
      if (msg.type === 'markerPress' && msg.payload?.lat !== undefined && msg.payload?.lng !== undefined) {
        const cluster = clusters.find(c => c.lat === msg.payload!.lat && c.lng === msg.payload!.lng);
        if (cluster) {openRegion(cluster);}
      }
    } catch {
      /* ignore malformed payloads */
    }
  };

  // Group the ITEMS (not clusters) per bucket key so tapping a bubble
  // can reveal every headline from that region. MUST use the same
  // clusterKey as the marker badges — two different keys here once made a
  // bubble say "2" while the tap revealed a different number.
  const regionHits = useMemo(() => {
    const m = new Map<string, IntelItem[]>();
    for (const it of mapItems) {
      if (typeof it.lat !== 'number' || typeof it.lng !== 'number') {continue;}
      const key = clusterKey({lat: it.lat, lng: it.lng, label: it.loc.replace('📍 ', '')});
      const arr = m.get(key) ?? [];
      arr.push(it);
      m.set(key, arr);
    }
    return m;
  }, [mapItems]);

  // On any bubble tap we synthesise a region drawer item whose summary
  // is the list of headlines — matches the preview's multi-article pane.
  const openRegion = (c: ReturnType<typeof clusterMarkers>[number]) => {
    const key = clusterKey(c);
    const hits = regionHits.get(key) ?? [];
    if (hits.length === 0) {return;}
    const headline = hits[0].headline;
    const aggregate: WireItem = {
      ...hits[0],
      id:       `REGION-${key}`,
      headline,
      loc:      `📍 ${c.label}`,
      src:      `SOURCE: ${hits.length} HEADLINE${hits.length === 1 ? '' : 'S'}`,
      // Carry the rest of the stack via trailText so the drawer can list them.
      trailText: hits.slice(0, 8).map((h, i) => `${i + 1}. ${h.headline}`).join('\n'),
      webUrl:   hits[0].webUrl,
    };
    // Hand the drawer the FULL stack (no cap) — the pager count must equal
    // the bubble badge exactly.
    openDrawer(aggregate, hits);
  };

  const tickerAnim = useRef(new Animated.Value(0)).current;
  const drawerAnim = useRef(new Animated.Value(300)).current;

  // B-656 — the clock's interval + state now live inside <UtcClock/>, so the
  // tick re-renders one <Text> instead of this entire screen.

  // Ticker scroll
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(tickerAnim, {toValue: -1200, duration: 60000, useNativeDriver: true}),
    );
    loop.start();
    return () => loop.stop();
  }, [tickerAnim]);

  // B-656 — stable identity: it is a dependency of `renderWireRow`, which is a
  // FlatList prop. `drawerAnim` is a ref-held Animated.Value, so the deps are
  // genuinely empty (the setters are stable by React's contract).
  const openDrawer = useCallback((item: WireItem, hits?: WireItem[]) => {
    setDrawerHits(hits && hits.length > 1 ? hits : null);
    setDrawerIndex(0);
    setDrawerItem(item);
    drawerAnim.setValue(400);
    Animated.spring(drawerAnim, {toValue: 0, useNativeDriver: true, tension: 60, friction: 10}).start();
  }, [drawerAnim]);

  /**
   * B-656 — the wire list's stable FlatList props. `renderItem` and
   * `contentContainerStyle` must not be re-created per render or
   * `VirtualizedList` (a PureComponent) re-renders its whole mounted window.
   */
  const renderWireRow = useCallback(
    ({item}: {item: WireItem}) => <WireRow item={item} onPress={openDrawer} />,
    [openDrawer],
  );
  // Uses the B-184 rule (`bottomPad`), not raw `insets.bottom` arithmetic —
  // this is the bottom-most scrollable surface, so it owns the inset. Pinned by
  // `bottomInsetContract.test.ts`, which caught the raw form when this moved
  // out of the JSX.
  const wireContentStyle = useMemo(
    () => ({paddingBottom: bottomPad(60)}),
    [bottomPad],
  );

  /**
   * B-656 — the map's stat row, in ONE pass and memoised. It used to run two
   * full `items.filter()` scans plus a 4-object array literal inline in the
   * render body, so it re-ran on every render of the screen.
   */
  const mapStats = useMemo(() => {
    let critical = 0;
    let high = 0;
    for (const i of items) {
      if (i.priority === 'CRITICAL') {critical++;}
      else if (i.priority === 'HIGH') {high++;}
    }
    return [
      {label: 'CRITICAL', value: String(critical),        color: '#FF3B30'},
      {label: 'HIGH',     value: String(high),            color: '#FFB800'},
      {label: 'TRACKED',  value: String(items.length),    color: Colors.primary},
      {label: 'LOCATED',  value: String(clusters.length), color: '#94A3B8'},
    ];
  }, [items, clusters.length]);

  /**
   * B-656 — the ticker rows, memoised. This was a bare IIFE in the render body
   * that rebuilt 10 `tickerTextFor` strings, a 20-element array and 80 elements
   * on every render — and it sits OUTSIDE the tab switch, so it was paid on
   * every tab. It is also the `children` of an `Animated.View`: RN's
   * AnimatedProps memo retains arrays BY REFERENCE, so a fresh children array
   * each render meant a brand-new AnimatedProps node — tearing down and
   * re-attaching the live marquee's native animation.
   */
  const tickerRows = useMemo(() => {
    const feed = items.length > 0
      ? items.slice(0, 10).map(i => ({color: i.priorityColor, text: tickerTextFor(i)}))
      : TICKER_FALLBACK;
    return [...feed, ...feed];
  }, [items]);

  // The card whose details (badges, timestamp, article link) the drawer
  // shows — the swiped-to hit for region opens, the item itself otherwise.
  const drawerCurrent = drawerHits?.[drawerIndex] ?? drawerItem;
  // Share-to-Bravo target. Held at screen level so the picker survives the
  // detail drawer closing underneath it.
  const [shareItem, setShareItem] = useState<ShareableNews | null>(null);
  // B-656 - stable, so React.memo(ShareNewsSheet) can actually bail out.
  const closeShare = useCallback(() => setShareItem(null), []);

  const closeDrawer = () => {
    Animated.timing(drawerAnim, {toValue: 400, duration: 220, useNativeDriver: true}).start(() => setDrawerItem(null));
  };

  // The Guardian query is already filtered server-side (section / q) so
  // `items` is the right set for the Wire tab; we just surface the
  // in-flight + error state alongside it.
  // On a specific chip the fetch is already scoped, so the pool is the pool.
  // On ALL, gate it to the user's saved News Filter categories — that is what
  // makes the selection "display across Bravo Feed and My Feed" rather than
  // only My Feed (founder 2026-08-09). An empty selection gates nothing.
  const filteredWire = useMemo(() => {
    if (wireFilter !== 'ALL' || savedCats.length === 0) {return items;}
    const kept = items.filter(i =>
      matchesAnyCategory(savedCats, `${i.headline} ${i.trailText ?? ''} ${i.tag}`.toLowerCase()));
    // Never blank the feed on a heuristic: if the keyword gate matches nothing
    // (narrow selection, quiet news day), show the unfiltered pool instead.
    return kept.length > 0 ? kept : items;
  }, [items, wireFilter, savedCats]);

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor="#0A0F1E" />

      {/* Top Bar */}
      <View style={styles.topbar}>
        <View style={styles.topLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="arrow-left" size={18} color="#64748B" />
          </TouchableOpacity>
          <View>
            <Text style={styles.logoText}>▌BRAVO FEED</Text>
            <Text style={styles.logoSub}>GLOBAL NEWS & INFORMATION</Text>
          </View>
        </View>
        <View style={styles.topRight}>
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveBadgeText}>LIVE FEED</Text>
          </View>
          <UtcClock />
          <Text style={styles.coords}>25°2'N · 55°22'E</Text>
        </View>
      </View>

      {/* Tab Bar */}
      <View style={styles.tabbar}>
        {([
          {id:'map', label:'BRAVO MAP'},
          {id:'wire', label:'BRAVO FEED', count: items.length ? String(items.length) : undefined, countColor: Colors.primary},
          // Founder 2026-08-09 — Signals is parked: it still renders a
          // hardcoded demo set, so it is greyed out and inert rather than
          // shipping placeholder intelligence as if it were live.
          {id:'signals', label:'SIGNALS', disabled: true},
        ] as {id:IntelTab; label:string; count?:string; countColor?:string; disabled?:boolean}[]).map(tab => (
          <TouchableOpacity key={tab.id}
            style={[styles.tab, activeTab === tab.id && !tab.disabled && styles.tabActive]}
            onPress={() => { if (!tab.disabled) {setActiveTab(tab.id);} }}
            activeOpacity={tab.disabled ? 1 : 0.7}
            disabled={tab.disabled}
            accessibilityRole="tab"
            accessibilityState={{selected: activeTab === tab.id && !tab.disabled, disabled: !!tab.disabled}}
            accessibilityLabel={tab.disabled ? `${tab.label}, coming soon` : tab.label}>
            <View style={{flexDirection:'row', alignItems:'center', gap:4}}>
              <Text style={[
                styles.tabText,
                activeTab === tab.id && !tab.disabled && styles.tabTextActive,
                tab.disabled && styles.tabTextDisabled,
              ]}>{tab.label}</Text>
              {tab.count && !tab.disabled && (
                <View style={[styles.tabCount, {backgroundColor: tab.countColor + '26'}]}>
                  <Text style={[styles.tabCountText, {color: tab.countColor}]}>{tab.count}</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      <View style={styles.content}>

        {/* ── BRAVO MAP ── Leaflet inside a WebView, countries filled
            in Bravo primary via a GeoJSON overlay. Pan/zoom is Leaflet
            native — inertia, momentum, pinch, easing all for free.
            Marker presses cross the bridge as postMessage so the
            region drawer opens on tap. */}
        {(activeTab === 'map' || mapVisited) && (
          <View
            style={activeTab === 'map' ? styles.mapContainer : styles.mapHidden}
            pointerEvents={activeTab === 'map' ? 'auto' : 'none'}>
            {/* B-89 MG-10 — this was the ONE map surface the B-77 recovery
                skipped: no renderer-crash handler, no watchdog, no RETRY —
                a CDN-blocked Leaflet fetch or a WebView renderer kill left
                a permanent blank. Same useMapReload pattern as the GL maps
                (the HTML posts 'ready' on load). */}
            <WebView
              key={`intel-map-${mapHealth.reloadKey}`}
              ref={mapWebViewRef}
              originWhitelist={['*']}
              source={MAP_SOURCE}
              style={styles.mapWebView}
              containerStyle={styles.mapWebView}
              onMessage={handleMapMessage}
              javaScriptEnabled
              domStorageEnabled
              mixedContentMode="compatibility"
              setSupportMultipleWindows={false}
              scrollEnabled={false}
              bounces={false}
              overScrollMode="never"
              androidLayerType="hardware"
              textZoom={100}
              allowsInlineMediaPlayback
              thirdPartyCookiesEnabled={false}
              onRenderProcessGone={mapHealth.retry}
              onContentProcessDidTerminate={mapHealth.retry}
              startInLoadingState
              renderLoading={renderMapLoading}
            />
            {mapHealth.status === 'failed' && <MapFailedOverlay onRetry={mapHealth.retry} />}

            {loading && items.length === 0 && (
              <View style={styles.mapLoadingOverlay} pointerEvents="none">
                <LoadingView compact />
                <Text style={styles.mapLoadingText}>FETCHING INTEL…</Text>
              </View>
            )}

            {/* Map bottom info */}
            <View style={styles.mapInfo}>
              <View style={styles.mapStatRow}>
                {mapStats.map(s => (
                  <View key={s.label} style={styles.mapStat}>
                    <Text style={styles.mapStatLabel}>{s.label}</Text>
                    <Text style={[styles.mapStatValue, {color: s.color}]}>{s.value}</Text>
                  </View>
                ))}
              </View>
              <Text style={styles.mapCoords}>SOURCE: GUARDIAN · OSINT · RSS · REDDIT · HN · BRAVO MAP</Text>
            </View>
          </View>
        )}

        {/* ── WIRE TAB ── */}
        {activeTab === 'wire' && (
          <View style={styles.wireContainer}>
            <View style={styles.wireHeader}>
              <Text style={styles.wireHeaderLabel}>BRAVO FEED STREAM</Text>
              <View style={styles.wireHeaderRight}>
                <View style={styles.liveDotSmall} />
                <Text style={styles.wireCount}>{filteredWire.length} ITEMS</Text>
              </View>
            </View>
            {/* Filter chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false}
              style={styles.filterChipsWrap} contentContainerStyle={styles.filterChipsContent}>
              {chips.map(f => (
                <TouchableOpacity key={f}
                  style={[styles.fchip, wireFilter === f && styles.fchipActive]}
                  onPress={() => setWireFilter(f)} activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityState={{selected: wireFilter === f}}
                  accessibilityLabel={`Filter by ${chipLabel(f)}`}>
                  <Text style={[styles.fchipText, wireFilter === f && styles.fchipTextActive]}>{chipLabel(f)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {/* Wire items — B-656 VIRTUALISED. Was a plain ScrollView + .map(),
                so every one of the ≤60 rows (≈10 native views each) mounted
                synchronously the moment this tab was tapped: the "stuck for a
                couple of seconds" tab switch. The row is memoised and every
                FlatList prop is a stable reference, so a re-render of this
                screen no longer touches the rows at all. */}
            <FlatList
              style={styles.wireList}
              data={filteredWire}
              keyExtractor={wireKeyExtractor}
              renderItem={renderWireRow}
              contentContainerStyle={wireContentStyle}
              showsVerticalScrollIndicator={false}
              initialNumToRender={8}
              maxToRenderPerBatch={8}
              windowSize={7}
              removeClippedSubviews
              ListEmptyComponent={
                loading ? (
                  <View style={styles.wireLoadingWrap}>
                    <LoadingView compact label="Fetching Guardian wire…" />
                  </View>
                ) : error ? (
                  <View style={styles.wireErrorWrap}>
                    <Icon name="wifi-off" size={28} color="#FF3B30" />
                    <Text style={styles.wireErrorTitle}>Feed unreachable</Text>
                    <Text style={styles.wireErrorHint}>{error}</Text>
                    <TouchableOpacity style={styles.wireRetryBtn} onPress={() => { void refresh(); }} activeOpacity={0.8}>
                      <Text style={styles.wireRetryText}>RETRY</Text>
                    </TouchableOpacity>
                  </View>
                ) : null
              }
            />
          </View>
        )}

        {/* ── SIGNALS TAB ── */}
        {activeTab === 'signals' && (
          <ScrollView style={styles.signalsScroll} showsVerticalScrollIndicator={false}
            contentContainerStyle={[styles.signalsContent, {paddingBottom: insets.bottom + 60}]}>
            <Text style={styles.sigMatrixLabel}>THREAT MATRIX — LIVE</Text>

            <Text style={styles.sigSectionLabel}>◆ CRITICAL SIGNALS</Text>
            {SIGNALS_CRITICAL.map(s => <SignalRow key={s.name} signal={s} />)}

            <Text style={styles.sigSectionLabel}>◆ HIGH SIGNALS</Text>
            {SIGNALS_HIGH.map(s => <SignalRow key={s.name} signal={s} />)}

            <Text style={styles.sigSectionLabel}>◆ MEDIUM / MONITOR</Text>
            {SIGNALS_MEDIUM.map(s => <SignalRow key={s.name} signal={s} />)}
          </ScrollView>
        )}
      </View>

      {/* Bottom Ticker — fed by the live Guardian wire, duplicated once
          for a seamless loop. Falls back to a "connecting" chip while
          the first fetch is in flight. The safe-area padding sits on an
          outer wrapper so the marquee row (minHeight 28, grows with
          fontScale) isn't clipped on phones with a large home-indicator
          inset. */}
      <View style={[styles.tickerOuter, {paddingBottom: bottomPad(4)}]}>
        <View style={styles.tickerWrap}>
          <View style={styles.tickerTag}>
            <Text style={styles.tickerTagText}>▶ WIRE</Text>
          </View>
          <View style={styles.tickerScroll}>
            <Animated.View style={[styles.tickerInner, {transform: [{translateX: tickerAnim}]}]}>
              {tickerRows.map((t, idx) => (
                <View key={idx} style={styles.tickerItem}>
                  <View style={[styles.tickerDot, {backgroundColor: t.color}]} />
                  <Text style={styles.tickerItemText} numberOfLines={1}>{t.text}</Text>
                  <Text style={styles.tickerSep}>·</Text>
                </View>
              ))}
            </Animated.View>
          </View>
        </View>
      </View>

      {/* Incident Drawer */}
      {drawerItem && (
        <Modal transparent animationType="none" onRequestClose={closeDrawer}>
          <Pressable style={styles.drawerBackdrop} onPress={closeDrawer} />
          <Animated.View style={[styles.drawerSheet, {paddingBottom: bottomPad(24), transform:[{translateY: drawerAnim}]}]}>
            <View style={styles.drawerHandle} />
            <View style={styles.drawerHeader}>
              <View>
                <Text style={styles.drawerCode}>{drawerItem.id}</Text>
                <View style={styles.drawerBadgeRow}>
                  <View style={[styles.drawerBadge, {backgroundColor: (drawerCurrent ?? drawerItem).priorityBg, borderColor: (drawerCurrent ?? drawerItem).priorityColor + '55'}]}>
                    <Text style={[styles.drawerBadgeText, {color: (drawerCurrent ?? drawerItem).priorityColor}]}>{(drawerCurrent ?? drawerItem).priority}</Text>
                  </View>
                  <View style={[styles.drawerBadge, {backgroundColor:'rgba(37,99,235,0.06)', borderColor:'#1E2D45'}]}>
                    <Text style={[styles.drawerBadgeText, {color:'#64748B'}]}>{(drawerCurrent ?? drawerItem).tag}</Text>
                  </View>
                </View>
              </View>
              <TouchableOpacity style={styles.drawerCloseBtn} onPress={closeDrawer} activeOpacity={0.7}>
                <Text style={styles.drawerCloseText}>✕ CLOSE</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.drawerBody}>
              {drawerHits ? (
                // Region bubble: one page per headline, swipe to browse.
                <View onLayout={e => setPagerW(e.nativeEvent.layout.width)}>
                  {pagerW > 0 && (
                    <ScrollView
                      horizontal
                      pagingEnabled
                      showsHorizontalScrollIndicator={false}
                      onMomentumScrollEnd={e => setDrawerIndex(
                        Math.min(drawerHits.length - 1,
                          Math.max(0, Math.round(e.nativeEvent.contentOffset.x / pagerW))))}>
                      {drawerHits.map(h => (
                        <View key={h.id} style={{width: pagerW}}>
                          <Text style={styles.drawerHeadline} numberOfLines={3}>{h.headline}</Text>
                          <Text style={styles.drawerSummary}>via {h.src.replace('SOURCE: ', '')}</Text>
                        </View>
                      ))}
                    </ScrollView>
                  )}
                  <View style={styles.pagerDots}>
                    {/* Dots only while they stay legible; the count text is
                        always exact (and must match the bubble badge). */}
                    {drawerHits.length <= 10 && drawerHits.map((_, i) => (
                      <View key={i} style={[styles.pagerDot, i === drawerIndex && styles.pagerDotOn]} />
                    ))}
                    <Text style={styles.pagerCount}>{drawerIndex + 1}/{drawerHits.length} · SWIPE</Text>
                  </View>
                </View>
              ) : (
                <>
                  <Text style={styles.drawerHeadline}>{drawerItem.headline}</Text>
                  <Text style={styles.drawerSummary}>via {drawerItem.src.replace('SOURCE: ','')}</Text>
                </>
              )}
              <View style={styles.drawerMetaRow}>
                <View style={styles.drawerMeta}><Text style={styles.drawerMetaText}>{drawerItem.loc}</Text></View>
                <View style={styles.drawerMeta}><Text style={styles.drawerMetaText}>{(drawerCurrent ?? drawerItem).ts}</Text></View>
                <View style={styles.drawerMeta}><Text style={styles.drawerMetaText}>{drawerItem.src}</Text></View>
              </View>
              <View style={styles.drawerActions}>
                <TouchableOpacity
                  style={[styles.drawerBtn, styles.drawerBtnPrimary]}
                  onPress={() => {
                    const url = drawerCurrent?.webUrl;
                    if (url) {Linking.openURL(url).catch(() => {});}
                    closeDrawer();
                  }}
                  activeOpacity={0.8}>
                  <Text style={styles.drawerBtnPrimaryText}>OPEN ARTICLE →</Text>
                </TouchableOpacity>
                {/* Founder 2026-08-05 — share the story into a Bravo chat or
                    group (not the OS sheet: the point is to keep the discussion
                    inside the app). Close the drawer first so the picker is not
                    stacked under this modal. */}
                <TouchableOpacity
                  style={[styles.drawerBtn, styles.drawerBtnSec]}
                  disabled={!drawerCurrent?.webUrl}
                  onPress={() => {
                    const it = drawerCurrent;
                    if (!it?.webUrl) {return;}
                    closeDrawer();
                    setShareItem({title: it.headline, url: it.webUrl, source: it.src});
                  }}
                  activeOpacity={0.8}>
                  <Text style={styles.drawerBtnSecText}>SHARE ↗</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.drawerBtn, styles.drawerBtnSec]} onPress={closeDrawer} activeOpacity={0.8}>
                  <Text style={styles.drawerBtnSecText}>DISMISS</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Animated.View>
        </Modal>
      )}

      <ShareNewsSheet item={shareItem} onClose={closeShare} />

      {/* Scanline overlay — operational-console effect from the HTML
          preview (every 4px row tinted 8% black). Rendered last so it
          paints on top of the map/wire content, and pointerEvents=none
          keeps taps passing through to the real UI underneath.
          B-656 — a module-level constant ELEMENT (see below `styles`), so
          React skips the whole 220-view subtree by reference identity. */}
      {SCANLINE_OVERLAY}
    </View>
  );
}

function SignalRow({signal}: {signal: Signal}) {
  return (
    <View style={[styles.sigRow, {backgroundColor: signal.sectionBg, borderColor: signal.sectionBorder}]}>
      <View style={styles.sigLeft}>
        <Text style={styles.sigName} numberOfLines={1}>{signal.name}</Text>
        <Text style={styles.sigRegion} numberOfLines={1}>{signal.region}</Text>
      </View>
      <View style={styles.sigBarWrap}>
        <View style={[styles.sigBar, {width: `${signal.value}%` as DimensionValue, backgroundColor: signal.color}]} />
      </View>
      <Text style={[styles.sigLevel, {color: signal.color}]}>{signal.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:'#0A0F1E'},

  topbar: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:12, paddingBottom:8, borderBottomWidth:1, borderBottomColor:'#1E2D45', backgroundColor:'#0A0F1E', position:'relative'},
  topLeft: {flexDirection:'row', alignItems:'center', gap:10},
  backBtn: {width:32, height:32, borderRadius:16, borderWidth:1, borderColor:'#1E2D45', backgroundColor:'rgba(37,99,235,0.05)', alignItems:'center', justifyContent:'center'},
  logoText: {fontSize:13, fontWeight:'700', letterSpacing:3, color: Colors.primary},
  logoSub: {fontSize:8, fontWeight:'500', letterSpacing:2, color:'#64748B'},
  topRight: {alignItems:'flex-end', gap:2},
  liveBadge: {flexDirection:'row', alignItems:'center', gap:5},
  liveDot: {width:6, height:6, borderRadius:3, backgroundColor: Colors.primary},
  liveBadgeText: {fontSize:9, fontWeight:'600', letterSpacing:1.5, color: Colors.primary},
  clock: {fontSize:9, color:'#64748B', letterSpacing:1},
  coords: {fontSize:8, color:'#64748B', letterSpacing:0.5},

  tabbar: {flexDirection:'row', borderBottomWidth:1, borderBottomColor:'#1E2D45', backgroundColor:'#0A0F1E'},
  tab: {flex:1, paddingVertical:8, alignItems:'center', borderBottomWidth:2, borderBottomColor:'transparent'},
  tabActive: {borderBottomColor: Colors.primary},
  tabText: {fontSize:9, fontWeight:'700', letterSpacing:2, color:'#64748B'},
  // Parked tab — dimmed so it reads as unavailable rather than merely unselected.
  tabTextDisabled: {color:'#3A4658'},
  tabTextActive: {color: Colors.primary},
  tabCount: {paddingHorizontal:4, paddingVertical:1, borderRadius:99, minWidth:14, alignItems:'center'},
  tabCountText: {fontSize:7, fontWeight:'700'},

  content: {flex:1},

  // Map
  mapContainer: {flex:1, position:'relative'},
  // Why: full-size (not 1x1) so Leaflet's viewport never resizes while hidden;
  // opacity 0 + pointerEvents none keeps it invisible and untouchable behind
  // the active tab, which renders after it and paints on top.
  mapHidden: {position:'absolute', top:0, left:0, right:0, bottom:0, opacity:0},
  mapWebView:   {flex:1, backgroundColor: '#06080C'},

  mapLoadingOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(10,15,30,0.45)'},
  mapLoadingText: {color: '#60A5FA', fontSize: 9, letterSpacing: 2, fontWeight: '700'},
  wireLoadingWrap: {alignItems: 'center', paddingVertical: 40, gap: 10},
  wireLoadingText: {color: '#64748B', fontSize: 11, letterSpacing: 1},
  wireErrorWrap: {alignItems: 'center', paddingVertical: 40, paddingHorizontal: 32, gap: 8},
  wireErrorTitle: {color: '#F1F5F9', fontSize: 13, fontWeight: '700'},
  wireErrorHint: {color: '#64748B', fontSize: 10, textAlign: 'center'},
  wireRetryBtn: {marginTop: 10, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 4, backgroundColor: 'rgba(37,99,235,0.1)', borderWidth: 1, borderColor: '#3B82F6'},
  wireRetryText: {color: Colors.primary, fontSize: 9, fontWeight: '800', letterSpacing: 2},
  mapInfo: {position:'absolute', bottom:0, left:0, right:0, paddingTop:32, paddingBottom:8, paddingHorizontal:12, backgroundColor:'rgba(10,15,30,0)'},
  mapStatRow: {flexDirection:'row', flexWrap:'wrap', gap:8},
  mapStat: {flexDirection:'row', alignItems:'center', gap:5, fontSize:8, paddingHorizontal:8, paddingVertical:4, borderRadius:4, borderWidth:1, borderColor:'#1E2D45', backgroundColor:'rgba(10,15,30,0.85)'},
  mapStatLabel: {fontSize:8, letterSpacing:1, color:'#64748B'},
  mapStatValue: {fontSize:8, fontWeight:'700'},
  mapCoords: {marginTop:6, fontSize:8, color:'#64748B', letterSpacing:1},

  // Wire
  wireContainer: {flex:1},
  wireHeader: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:12, paddingVertical:8, borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  wireHeaderLabel: {fontSize:9, letterSpacing:2, color:'#64748B'},
  wireHeaderRight: {flexDirection:'row', alignItems:'center', gap:4},
  liveDotSmall: {width:5, height:5, borderRadius:3, backgroundColor: Colors.primary},
  wireCount: {fontSize:8, color:'#64748B'},
  filterChipsWrap: {flexGrow:0, flexShrink:0, borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  filterChipsContent: {gap:6, paddingHorizontal:12, paddingVertical:8},
  fchip: {paddingHorizontal:10, paddingVertical:3, borderRadius:4, borderWidth:1, borderColor:'#1E2D45'},
  fchipActive: {borderColor:'#3B82F6', backgroundColor:'rgba(37,99,235,0.07)'},
  fchipText: {fontSize:8, fontWeight:'700', letterSpacing:1.5, color:'#64748B'},
  fchipTextActive: {color: Colors.primary},
  wireList: {flex:1},
  wireItem: {paddingVertical:10, paddingHorizontal:12, borderBottomWidth:1, borderBottomColor:'#1E2D45', borderLeftWidth:2},
  itemMeta: {flexDirection:'row', alignItems:'center', gap:6, marginBottom:4, flexWrap:'wrap'},
  itemCode: {fontSize:8, fontWeight:'700', letterSpacing:1.5, color:'#64748B'},
  itemBadge: {paddingHorizontal:5, paddingVertical:1, borderRadius:2, borderWidth:1},
  itemBadgeText: {fontSize:7, fontWeight:'800', letterSpacing:1},
  itemTs: {fontSize:8, color:'#334155', marginLeft:'auto'},
  itemHeadline: {fontSize:12, fontWeight:'600', lineHeight:17, color:'#F1F5F9', marginBottom:4},
  itemFooter: {flexDirection:'row', alignItems:'center'},
  itemLoc: {fontSize:8, letterSpacing:1, color:'#64748B'},
  itemSrc: {fontSize:8, color:'#334155', marginLeft:'auto'},

  // Signals
  signalsScroll: {flex:1},
  signalsContent: {padding:12, gap:4},
  sigMatrixLabel: {fontSize:8, letterSpacing:2, color:'#64748B', paddingBottom:4},
  sigSectionLabel: {fontSize:8, letterSpacing:2, color:'#64748B', marginTop:12, marginBottom:6},
  sigRow: {flexDirection:'row', alignItems:'center', paddingHorizontal:10, paddingVertical:8, borderRadius:4, borderWidth:1, marginBottom:4},
  sigLeft: {minWidth:110, maxWidth:'38%', flexShrink:1},
  sigName: {fontSize:10, fontWeight:'600', color:'#F1F5F9'},
  sigRegion: {fontSize:8, color:'#64748B', letterSpacing:0.5, marginTop:1},
  sigBarWrap: {flex:1, marginHorizontal:10, height:3, borderRadius:2, backgroundColor:'#1E2D45', overflow:'hidden'},
  sigBar: {height:'100%', borderRadius:2},
  sigLevel: {fontSize:9, fontWeight:'700', letterSpacing:1, minWidth:28, textAlign:'right'},

  // Ticker
  tickerOuter: {backgroundColor:'#0D1929', borderTopWidth:1, borderTopColor:'#1E2D45'},
  tickerWrap: {minHeight:28, flexDirection:'row', alignItems:'center', overflow:'hidden'},
  // Why: alignSelf:'stretch', never height:'100%' — the wrap's height is minHeight-
  // driven (FS-61), so a percentage has no definite anchor and blew up to screen
  // height (B-682). Stretch fills the row whatever drives its height.
  tickerTag: {paddingHorizontal:8, alignSelf:'stretch', justifyContent:'center', backgroundColor: Colors.primary, borderRightWidth:1, borderRightColor:'#1E2D45'},
  tickerTagText: {fontSize:8, fontWeight:'800', letterSpacing:2, color:'#0A0F1E'},
  tickerScroll: {flex:1, overflow:'hidden'},
  tickerInner: {flexDirection:'row', alignItems:'center', gap:0},
  tickerItem: {flexDirection:'row', alignItems:'center', gap:8, paddingHorizontal:16},
  tickerDot: {width:4, height:4, borderRadius:2, flexShrink:0},
  tickerItemText: {fontSize:9, color:'#64748B', letterSpacing:0.5},
  tickerSep: {color:'#334155', fontSize:12},

  // Scanline overlay — fixed-position, top of the stack, transparent taps.
  scanlineOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, overflow: 'hidden'},
  scanline: {height: 2, marginBottom: 2, backgroundColor: 'rgba(0,0,0,0.08)'},

  // Drawer
  drawerBackdrop: {position:'absolute', top:0, bottom:0, left:0, right:0, backgroundColor:'rgba(0,0,0,0.5)'},
  drawerSheet: {position:'absolute', bottom:0, left:0, right:0, backgroundColor:'#0D1929', borderTopWidth:1, borderTopColor:'#3B82F6', borderRadius:14, paddingBottom:24, maxHeight:'82%', overflow:'hidden'},
  drawerHandle: {width:48, height:5, borderRadius:3, backgroundColor:'#3B82F6', marginTop:12, marginBottom:4, alignSelf:'center'},
  drawerHeader: {flexDirection:'row', alignItems:'flex-start', justifyContent:'space-between', paddingHorizontal:16, paddingVertical:12, borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  drawerBadgeRow: {flexDirection:'row', gap:5, marginTop:4},
  drawerBadge: {paddingHorizontal:6, paddingVertical:2, borderRadius:2, borderWidth:1},
  drawerBadgeText: {fontSize:7, fontWeight:'800', letterSpacing:1},
  drawerCode: {fontSize:8, fontWeight:'700', letterSpacing:2, color:'#64748B'},
  drawerCloseBtn: {paddingHorizontal:8, paddingVertical:4, borderWidth:1, borderColor:'#1E2D45', borderRadius:3},
  drawerCloseText: {fontSize:9, fontWeight:'700', letterSpacing:1, color:'#64748B'},
  drawerBody: {padding:16},
  drawerHeadline: {fontSize:13, fontWeight:'700', color:'#F1F5F9', lineHeight:19, marginVertical:8},
  drawerSummary: {fontSize:11, color:'#64748B', lineHeight:17, marginBottom:10},
  pagerDots: {flexDirection:'row', alignItems:'center', gap:5, marginBottom:10},
  pagerDot: {width:6, height:6, borderRadius:3, backgroundColor:'#1E2D45'},
  pagerDotOn: {backgroundColor:'#3B82F6'},
  pagerCount: {marginLeft:6, fontSize:9, color:'#64748B', fontWeight:'700', letterSpacing:1},
  drawerMetaRow: {flexDirection:'row', flexWrap:'wrap', gap:8, marginBottom:12},
  drawerMeta: {paddingHorizontal:8, paddingVertical:3, borderWidth:1, borderColor:'#1E2D45', borderRadius:3},
  drawerMetaText: {fontSize:8, letterSpacing:1, color:'#64748B'},
  drawerActions: {flexDirection:'row', gap:8},
  drawerBtn: {flex:1, paddingVertical:10, borderRadius:6, alignItems:'center'},
  drawerBtnPrimary: {backgroundColor:'rgba(37,99,235,0.1)', borderWidth:1, borderColor:'#3B82F6'},
  drawerBtnPrimaryText: {fontSize:9, fontWeight:'800', letterSpacing:2, color: Colors.primary},
  drawerBtnSec: {backgroundColor:'transparent', borderWidth:1, borderColor:'#1E2D45'},
  drawerBtnSecText: {fontSize:9, fontWeight:'800', letterSpacing:2, color:'#64748B'},
}));

/**
 * B-656 — the scanline overlay, built ONCE at module load.
 *
 * A fixed 220-band CRT tint that never varies, it used to be constructed inline
 * in the render body — so a fresh 220-element array and 220 fresh elements were
 * allocated and reconciled on EVERY render of this screen, which the 1 Hz clock
 * made 60 times a minute, forever.
 *
 * A module-level constant ELEMENT is the fix: React compares
 * `oldElement === newElement` and skips the whole subtree.
 *
 * ⚠️ DELIBERATELY NOT DELETED. The 8%-black 4 px lattice is the screen's
 * intended console aesthetic. Deleting it is exactly the "costs the design and
 * buys nothing" move CLAUDE.md's lag section warns about, and the RN-side
 * per-frame paint cost that would justify removing it has never been measured.
 *
 * ⚠️ MUST stay BELOW `styles` — it dereferences `styles.*` at module-evaluation
 * time, so declaring it above the `const styles = ...` block is a temporal
 * dead-zone ReferenceError at import, not a lint nit.
 */
const SCANLINE_OVERLAY = (
  <View pointerEvents="none" style={styles.scanlineOverlay}>
    {Array.from({length: 220}).map((_, i) => (
      <View key={i} style={styles.scanline} />
    ))}
  </View>
);
