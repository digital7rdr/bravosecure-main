import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator,
  Keyboard, Linking, Platform, BackHandler, LayoutAnimation, UIManager,
  type DimensionValue,
} from 'react-native';
import Svg, {Path, Circle} from 'react-native-svg';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {vbgApi, type VbgSraSnapshot, type VbgKeyPoint} from '@/services/api';
import {scaleTextStyles} from '@utils/scaling';
import {ShareNewsSheet, type ShareableNews} from '@/modules/news/ShareNewsSheet';
import {useVbgLocation} from './useVbgLocation';
import {VbgFooter} from './VbgFooter';
import {VbgKeyPointsMap} from './VbgKeyPointsMap';
import {resolveAnalysisCoords} from './vbgGeoRiskCoords';
import {toggleExpanded, collapseAll} from './vbgRiskExpansion';
import {retryTransient} from './vbgRetry';
import {
  VBG, VbgScreen, VbgCard, SectionLabel, RiskBadge, PillButton, IconButton, ShareIcon,
  type RiskLevel,
} from './vbgUi';
import {goBackOnce} from '@navigation/tapGuard';
import {Imagery} from '@theme/imagery';

// Why: LayoutAnimation is a no-op on old-arch Android without this opt-in.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
const animateNext = () => LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';

const RADII = [5, 50, 200] as const;
const WINDOWS = [
  {label: 'Last 24h', hours: 24},
  {label: 'Last 48h', hours: 48},
  {label: 'Last 72h', hours: 72},
] as const;

const SCORE_COLOR = (lvl: VbgSraSnapshot['level']): string =>
  lvl === 'CRITICAL' ? '#FF5D5D' : lvl === 'HIGH' ? '#FF7A5C' : lvl === 'MEDIUM' ? VBG.amber : VBG.signal;

interface Suggestion {
  id:    string;
  name:  string;   // "Punjab"
  full:  string;   // "Punjab, India"
  lat:   number;
  lng:   number;
}

function dotFor(level: RiskLevel): string {
  return level === 'high' || level === 'critical' ? '#FF5D5D'
    : level === 'medium' || level === 'elevated' || level === 'caution' ? VBG.amber : VBG.signal;
}

function agoLabel(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) {return '';}
  const m = Math.floor(ms / 60000);
  if (m < 60) {return `${m}m ago`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h ago`;}
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * GeoRisk — the VBG search surface. Pick a location (typed → forward
 * geocode, or "Use My GPS"), a radius (5/50/200 km) and a time window
 * (24/48/72 h), then "Run Security Analysis" calls /vbg/sra with those
 * scopes and renders the assessment below. Every control is wired to the
 * backend — radius scopes the summary/key-point ring, the time window
 * scopes the live-threat lookback (GDELT timespan).
 */
// B-91 M2 R3 — the controls+results cluster is a reusable PANEL so the Home
// dashboard embeds it inline (spec: scroll Principal → Run Security Analysis
// without changing tabs) while this screen keeps hosting it for deep links.
export function GeoRiskPanel() {
  // The panel always mounts under BookingNavigator (GeoRisk screen + the Home
  // dashboard inline embed), so VBGMap is reachable for the map expand.
  const navigation = useNavigation<NativeStackNavigationProp<BookingStackParamList>>();
  const {fix: gpsFix, ready} = useVbgLocation();

  const [query, setQuery] = useState('');
  const [coords, setCoords] = useState<{lat: number; lng: number} | null>(null);
  const [usingGps, setUsingGps] = useState(false);
  const [radiusKm, setRadiusKm] = useState<number>(5);
  const [timeWindowHours, setTimeWindowHours] = useState<number>(24);

  // Map-style location autocomplete: debounced Mapbox suggestions as you type.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  // Android hardware-back: if the autocomplete dropdown is open, close IT first
  // instead of popping the whole screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (showSuggest) { setShowSuggest(false); return true; }
      return false;
    });
    return () => sub.remove();
  }, [showSuggest]);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When the user picks a suggestion we suppress the next auto-fetch so the
  // dropdown doesn't immediately re-open from the programmatic setQuery.
  const justPicked = useRef(false);
  // Why: async geocode flows resolve after unmount without this guard.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const [resolving, setResolving] = useState(false);
  const [running, setRunning] = useState(false);
  const [sra, setSra] = useState<VbgSraSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sraRetrying, setSraRetrying] = useState(false);
  // Map state — the analysed centre, the radius that was run, and the key
  // points found inside it (so the result map matches the analysis exactly).
  const [analysed, setAnalysed] = useState<{centre: {lat: number; lng: number}; radiusKm: number} | null>(null);
  const [keypoints, setKeypoints] = useState<VbgKeyPoint[]>([]);
  // Key-points lookup lifecycle — Overpass is transiently flaky, so the fetch
  // self-retries and the label reflects loading / retrying / an honest miss.
  const [kpStatus, setKpStatus] = useState<'idle' | 'loading' | 'retrying' | 'empty' | 'done'>('idle');
  // Why: retries stretch the fetch window — a newer run must win over a
  // still-retrying older one, so each run takes a sequence ticket.
  const kpRunSeq = useRef(0);
  // B-410 (founder 2026-08-09) — a SET, not one name. This was a single-select
  // accordion: opening "Robbery / Theft" silently collapsed "Violent Crime",
  // so the categories could never be compared side by side — which is the
  // whole point of a risk assessment. Any number may now stay open.
  const [expandedRisks, setExpandedRisks] = useState<ReadonlySet<string>>(collapseAll);
  const toggleRisk = useCallback((name: string) => {
    setExpandedRisks(prev => toggleExpanded(prev, name));
  }, []);
  const [recsOpen, setRecsOpen] = useState(false);
  // Founder 2026-08-08 — VBG news joins the 2026-08-05 share-to-Bravo rule:
  // risk articles shareable to internal chats/groups, never the OS sheet.
  // Lives in the PANEL so the Home dashboard embed gets it too.
  const [shareItem, setShareItem] = useState<ShareableNews | null>(null);

  const openInMaps = useCallback((kp: VbgKeyPoint) => {
    const label = encodeURIComponent(kp.label);
    const url = Platform.select({
      ios: `http://maps.apple.com/?q=${label}&ll=${kp.lat},${kp.lng}`,
      android: `geo:${kp.lat},${kp.lng}?q=${kp.lat},${kp.lng}(${label})`,
      default: `https://maps.google.com/?q=${kp.lat},${kp.lng}`,
    });
    Linking.openURL(url).catch(() => {});
  }, []);

  const useGps = useCallback(() => {
    if (!ready) {return;}
    if (!gpsFix) { setError('Location unavailable — enter a place instead.'); return; }
    setCoords({lat: gpsFix.lat, lng: gpsFix.lng});
    setUsingGps(true);
    setSuggestions([]);
    setShowSuggest(false);
    setError(null);
    // Reverse-geocode the fix to a readable place name and auto-fill the search
    // box, so the user can SEE where "my location" resolved to. justPicked
    // suppresses the autocomplete effect that would otherwise re-open on the
    // programmatic setQuery. Falls back to a coords label if geocoding fails.
    justPicked.current = true;
    setQuery('Locating…');
    void (async () => {
      let label = `${gpsFix.lat.toFixed(4)}, ${gpsFix.lng.toFixed(4)}`;
      if (MAPBOX_TOKEN) {
        try {
          const url =
            `https://api.mapbox.com/geocoding/v5/mapbox.places/${gpsFix.lng},${gpsFix.lat}.json` +
            `?language=en&types=place,locality,district,region&limit=1&access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;
          const res = await fetch(url);
          if (res.ok) {
            const body = await res.json() as {features?: Array<{text?: string; place_name?: string}>};
            const f = body.features?.[0];
            if (f) { label = f.place_name ?? f.text ?? label; }
          }
        } catch { /* keep the coords label */ }
      }
      if (!aliveRef.current) {return;}
      justPicked.current = true;   // re-arm: the setQuery below must not re-open suggestions
      setQuery(label);
    })();
  }, [ready, gpsFix]);

  // Debounced location autocomplete — Mapbox forward geocode w/ autocomplete.
  useEffect(() => {
    if (justPicked.current) { justPicked.current = false; return; }
    if (suggestTimer.current) {clearTimeout(suggestTimer.current);}
    const q = query.trim();
    if (usingGps || q.length < 2 || !MAPBOX_TOKEN) { setSuggestions([]); setShowSuggest(false); return; }
    // Why: abort superseded requests — a slow older response must not
    // overwrite suggestions for a newer keystroke (stale-response race).
    const ctrl = new AbortController();
    suggestTimer.current = setTimeout(() => { void (async () => {
      try {
        const url =
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
          `?autocomplete=true&limit=5&language=en&types=place,region,district,locality,country&access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;
        const res = await fetch(url, {signal: ctrl.signal});
        if (!res.ok) {return;}
        const body = await res.json() as {features?: Array<{id: string; text?: string; place_name?: string; center?: [number, number]}>};
        if (ctrl.signal.aborted || !aliveRef.current) {return;}
        const sugg: Suggestion[] = (body.features ?? [])
          .filter(f => f.center)
          .map(f => ({id: f.id, name: f.text ?? '', full: f.place_name ?? f.text ?? '', lng: f.center![0], lat: f.center![1]}));
        setSuggestions(sugg);
        setShowSuggest(sugg.length > 0);
      } catch { /* ignore — aborted or user can still hit search */ }
    })(); }, 250);
    return () => {
      ctrl.abort();
      if (suggestTimer.current) {clearTimeout(suggestTimer.current);}
    };
  }, [query, usingGps]);

  // User taps a suggestion → lock it in (fill box + coords), close dropdown.
  const pickSuggestion = useCallback((s: Suggestion) => {
    justPicked.current = true;
    setQuery(s.full);
    setCoords({lat: s.lat, lng: s.lng});
    setUsingGps(false);
    setSuggestions([]);
    setShowSuggest(false);
    setError(null);
    Keyboard.dismiss();
  }, []);

  // Forward-geocode the typed place to a center. Returns null on miss.
  const geocode = useCallback(async (q: string): Promise<{lat: number; lng: number} | null> => {
    if (!MAPBOX_TOKEN || q.trim().length < 2) {return null;}
    try {
      const url =
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q.trim())}.json` +
        `?limit=1&language=en&access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;
      const res = await fetch(url);
      if (!res.ok) {return null;}
      const body = await res.json() as {features?: Array<{center?: [number, number]}>};
      const c = body.features?.[0]?.center;
      return c ? {lng: c[0], lat: c[1]} : null;
    } catch {
      return null;
    }
  }, []);

  const run = useCallback(async () => {
    Keyboard.dismiss();
    setError(null);
    setRunning(true);
    try {
      const needsGeocode = !usingGps && query.trim().length >= 2;
      if (needsGeocode) {setResolving(true);}
      const geocoded = needsGeocode ? await geocode(query) : null;
      if (needsGeocode) {
        setResolving(false);
        setCoords(geocoded);
      }
      const resolved = resolveAnalysisCoords({usingGps, coords, query, geocoded});
      if (resolved.kind === 'error') {
        setError(resolved.message);
        setRunning(false);
        return;
      }
      const centre = {lat: resolved.lat, lng: resolved.lng};
      // The SRA is the critical result — render it AS SOON as it's ready and
      // never let the (sometimes-slow) key-points lookup block or fail it.
      // The blend upstream (GDELT/NewsData) can transiently fail on the first
      // hit, so the fetch self-retries before surfacing the error state.
      const sraRes = await retryTransient(
        () => vbgApi.sra({lat: centre.lat, lng: centre.lng, radiusKm, timeWindowHours}),
        {onRetry: () => { if (aliveRef.current) {setSraRetrying(true);} }},
      );
      animateNext();
      setSra(sraRes.data);
      setRecsOpen(false);
      // A fresh analysis is a different area — start every category collapsed.
      setExpandedRisks(collapseAll());
      setAnalysed({centre, radiusKm});
      setKeypoints([]);
      setKpStatus('loading');
      setRunning(false);
      // Key points fill in afterwards (Overpass can be slow AND transiently
      // empty); the map shows the radius circle immediately, the fetch
      // self-retries, and an empty answer after retries is an honest miss.
      const seq = ++kpRunSeq.current;
      retryTransient(
        () => vbgApi.keypoints({lat: centre.lat, lng: centre.lng, radiusKm}).then(r => r.data.keypoints),
        {
          isEmpty: kps => kps.length === 0,
          onRetry: () => { if (aliveRef.current && kpRunSeq.current === seq) {setKpStatus('retrying');} },
        },
      )
        .then(kps => {
          if (!aliveRef.current || kpRunSeq.current !== seq) {return;}
          setKeypoints(kps);
          setKpStatus(kps.length > 0 ? 'done' : 'empty');
        })
        .catch(() => {
          // Leave the map with just the circle, but say so instead of hanging.
          if (aliveRef.current && kpRunSeq.current === seq) {setKpStatus('empty');}
        });
      return;
    } catch {
      setError('Security analysis unavailable. Try again.');
      setSra(null);
    } finally {
      setResolving(false);
      setRunning(false);
      setSraRetrying(false);
    }
  }, [coords, usingGps, query, geocode, radiusKm, timeWindowHours]);

  const score = sra?.risk_score ?? 0;
  const busy = running || resolving;

  return (
      <View style={styles.body}>
        {/* Search Location */}
        <VbgCard pad={15} img={Imagery.vbgGeoRisk} imgVariant="card">
          <View style={styles.cardHead}>
            <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
              <Circle cx={11} cy={11} r={7} stroke={VBG.accentSoft} strokeWidth={1.8} fill="none" />
              <Path d="M20 20l-4-4" stroke={VBG.accentSoft} strokeWidth={1.8} strokeLinecap="round" />
            </Svg>
            <SectionLabel color={VBG.text}>Search Location</SectionLabel>
          </View>
          <View style={styles.searchRow}>
            <TextInput
              value={query}
              onChangeText={t => { setQuery(t); setUsingGps(false); setCoords(null); }}
              placeholder="Search city, area, or region…"
              placeholderTextColor={VBG.textMute}
              style={styles.input}
              returnKeyType="search"
              autoCorrect={false}
              onFocus={() => { if (suggestions.length) {setShowSuggest(true);} }}
              onSubmitEditing={() => { void run(); }}
            />
            <TouchableOpacity activeOpacity={0.8} style={styles.searchBtn} onPress={() => { void run(); }}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                <Circle cx={11} cy={11} r={7} stroke="#fff" strokeWidth={1.9} fill="none" />
                <Path d="M20 20l-4-4" stroke="#fff" strokeWidth={1.9} strokeLinecap="round" />
              </Svg>
            </TouchableOpacity>
          </View>

          {/* Autocomplete dropdown — map-style suggestions as you type */}
          {showSuggest && suggestions.length > 0 ? (
            <View style={styles.suggestBox}>
              {suggestions.map((s, i) => (
                <TouchableOpacity
                  key={s.id}
                  activeOpacity={0.7}
                  onPress={() => pickSuggestion(s)}
                  style={[styles.suggestRow, i < suggestions.length - 1 && styles.suggestBorder]}>
                  <Svg width={13} height={13} viewBox="0 0 24 24" fill="none" style={{marginTop: 1}}>
                    <Path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7Z" stroke={VBG.accentSoft} strokeWidth={1.7} fill="none" strokeLinejoin="round" />
                    <Circle cx={12} cy={9} r={2.2} stroke={VBG.accentSoft} strokeWidth={1.5} fill="none" />
                  </Svg>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={styles.suggestName} numberOfLines={1}>{s.name}</Text>
                    <Text style={styles.suggestFull} numberOfLines={1}>{s.full}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          <TouchableOpacity activeOpacity={ready ? 0.85 : 1} disabled={!ready} style={[styles.gpsBtn, usingGps && styles.gpsBtnOn, !ready && {opacity: 0.55}]} onPress={useGps}>
            <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
              <Circle cx={12} cy={12} r={3.2} stroke={usingGps ? VBG.accent : VBG.accentSoft} strokeWidth={1.7} fill="none" />
              <Path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke={usingGps ? VBG.accent : VBG.accentSoft} strokeWidth={1.7} strokeLinecap="round" />
            </Svg>
            <Text style={[styles.gpsText, usingGps && {color: VBG.accent}]}>
              {!ready ? 'Locating…' : usingGps ? 'Using My GPS Location' : 'Use My GPS Location'}
            </Text>
          </TouchableOpacity>
        </VbgCard>

        {/* Analysis Parameters */}
        <VbgCard pad={15}>
          <SectionLabel color={VBG.text} style={{marginBottom: 13}}>Analysis Parameters</SectionLabel>

          <Text style={styles.paramLabel}>Search Radius</Text>
          <View style={styles.segRow}>
            {RADII.map(r => (
              <Seg key={r} active={radiusKm === r} onPress={() => setRadiusKm(r)} label={`${r}km`} />
            ))}
          </View>

          <Text style={[styles.paramLabel, {marginTop: 15}]}>Time Window</Text>
          <View style={styles.segRow}>
            {WINDOWS.map(w => (
              <Seg key={w.hours} active={timeWindowHours === w.hours} onPress={() => setTimeWindowHours(w.hours)} label={w.label} />
            ))}
          </View>
        </VbgCard>

        {/* Run */}
        <PillButton variant="primary" full height={52} onPress={() => { void run(); }}>
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                <Path d="M3 12h4l2 6 4-13 2 7h6" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </Svg>
              <Text style={styles.runText}>RUN SECURITY ANALYSIS</Text>
            </>
          )}
        </PillButton>

        {busy && sraRetrying ? <Text style={styles.retrying}>Retrying…</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {/* Results */}
        {sra ? (
          <View style={{gap: 13, marginTop: 2}}>
            <VbgCard rail={SCORE_COLOR(sra.level)} pad={15}>
              {/* Founder rule 2026-08-01: the Executive Summary is ALWAYS
                  shown in full — never truncated, never behind a tap. */}
              <SectionLabel style={styles.summaryHead}>Executive Summary · {sra.region}</SectionLabel>
              <Text style={styles.summary}>{sra.summary}</Text>
              <View style={styles.scoreHead}>
                <Text style={styles.scoreLabel}>Risk Score · {radiusKm}km · {timeWindowHours}h</Text>
                <Text style={styles.scoreVal}>{score}<Text style={styles.scoreOf}>/100</Text></Text>
              </View>
              <View style={styles.scoreTrack}>
                <View style={[styles.scoreFill, {width: `${score}%` as DimensionValue, backgroundColor: SCORE_COLOR(sra.level)}]} />
              </View>
            </VbgCard>

            {/* Map — the analysed radius circle centered on the location, with
                the key points found inside it. */}
            {analysed ? (
              <View>
                <SectionLabel style={{marginLeft: 2, marginBottom: 10}}>
                  Analysis Area · {analysed.radiusKm}km
                  {keypoints.length > 0 ? ` · ${keypoints.length} key points`
                    : kpStatus === 'retrying' ? ' · retrying key points…'
                      : kpStatus === 'loading' ? ' · locating key points…'
                        : kpStatus === 'empty' ? ' · no key points found' : ''}
                </SectionLabel>
                <VbgKeyPointsMap
                  centre={analysed.centre}
                  radiusKm={analysed.radiusKm}
                  points={keypoints}
                  onTapPoint={openInMaps}
                  onExpand={() => navigation.navigate('VBGMap', {
                    centre: analysed.centre,
                    radiusKm: analysed.radiusKm,
                    points: keypoints,
                  })}
                  style={styles.map}
                />
              </View>
            ) : null}

            <View>
              <SectionLabel style={{marginLeft: 2, marginBottom: 10}}>Potential Risks <Text style={styles.tapHint}>· tap to see news</Text></SectionLabel>
              <VbgCard pad={4} radius={16}>
                {sra.risks.map((r, i, arr) => {
                  const articles = r.articles ?? [];
                  const open = expandedRisks.has(r.name);
                  return (
                    <View key={r.name} style={i < arr.length - 1 ? styles.riskBorder : undefined}>
                      <TouchableOpacity
                        activeOpacity={articles.length ? 0.7 : 1}
                        onPress={() => { if (articles.length) { animateNext(); toggleRisk(r.name); } }}
                        style={styles.riskRow}
                        accessibilityRole="button"
                        accessibilityState={{expanded: open, disabled: articles.length === 0}}
                        accessibilityLabel={
                          articles.length
                            ? `${r.name}, ${r.level} risk, ${articles.length} ${articles.length === 1 ? 'report' : 'reports'}`
                            : `${r.name}, ${r.level} risk, no reports`
                        }>
                        <View style={styles.riskLeft}>
                          <View style={[styles.riskDot, {backgroundColor: dotFor(r.level as RiskLevel), shadowColor: dotFor(r.level as RiskLevel)}]} />
                          <Text style={styles.riskName}>{r.name}</Text>
                          {articles.length > 0 ? <Text style={styles.riskCount}>{articles.length}</Text> : null}
                        </View>
                        <View style={styles.riskRight}>
                          <View style={styles.riskBadgeSlot}>
                            <RiskBadge level={r.level as RiskLevel} small>{r.level}</RiskBadge>
                          </View>
                          {/* Fixed-width chevron slot — reserved even when empty
                              so every row's badge lines up in the same column. */}
                          <View style={styles.riskChevron}>
                            {articles.length > 0 ? (
                              <Svg width={9} height={9} viewBox="0 0 12 12" style={{transform: [{rotate: open ? '90deg' : '0deg'}]}}>
                                <Path d="M3 1.5l5 4.5-5 4.5" stroke={VBG.textMute} strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                              </Svg>
                            ) : null}
                          </View>
                        </View>
                      </TouchableOpacity>
                      {open ? (
                        <View style={styles.newsWrap}>
                          {articles.map((a, ai) => (
                            <TouchableOpacity
                              key={`${a.url}-${ai}`}
                              activeOpacity={0.75}
                              onPress={() => { if (a.url) {Linking.openURL(a.url).catch(() => {});} }}
                              style={styles.newsRow}>
                              <View style={[styles.newsDot, {backgroundColor: dotFor((a.severity === 'critical' ? 'critical' : a.severity === 'caution' ? 'caution' : 'info') as RiskLevel)}]} />
                              <View style={{flex: 1, minWidth: 0}}>
                                <Text style={styles.newsTitle} numberOfLines={3}>{a.title}</Text>
                                <Text style={styles.newsMeta}>{a.source} · {agoLabel(a.seenAt)}</Text>
                              </View>
                              {a.url ? (
                                <TouchableOpacity
                                  onPress={() => setShareItem({title: a.title, url: a.url, source: a.source})}
                                  hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
                                  accessibilityRole="button"
                                  accessibilityLabel={`Share: ${a.title}`}
                                  style={styles.newsShare}>
                                  <ShareIcon size={14} />
                                </TouchableOpacity>
                              ) : null}
                            </TouchableOpacity>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </VbgCard>
            </View>

            <View>
              <SectionLabel style={{marginLeft: 2, marginBottom: 10}}>Recommendations</SectionLabel>
              <VbgCard pad={15}>
                {/* Summary (first 2) always visible; the rest behind tap-to-expand. */}
                <View style={{gap: 14}}>
                  {(recsOpen ? sra.recommendations : sra.recommendations.slice(0, 2)).map(rec => (
                    <View key={rec} style={styles.recRow}>
                      <Svg width={16} height={16} viewBox="0 0 20 20" style={{marginTop: 1}}>
                        <Circle cx={10} cy={10} r={8.5} stroke="rgba(91,141,239,0.4)" strokeWidth={1.3} fill="rgba(91,141,239,0.1)" />
                        <Path d="M6.5 10.2l2.3 2.3 4.5-4.8" stroke="#A9C5FF" strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      </Svg>
                      <Text style={styles.recText}>{rec}</Text>
                    </View>
                  ))}
                </View>
                {sra.recommendations.length > 2 ? (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => { animateNext(); setRecsOpen(o => !o); }}
                    style={styles.expandFoot}>
                    <Text style={styles.expandFootText}>
                      {recsOpen ? 'Show less' : `+${sra.recommendations.length - 2} more · tap to expand`}
                    </Text>
                    <Chevron open={recsOpen} />
                  </TouchableOpacity>
                ) : null}
              </VbgCard>
            </View>
          </View>
        ) : !busy && !error ? (
          <Text style={styles.hint}>
            Set a location, radius and time window, then run the analysis to see a live security assessment for that area.
          </Text>
        ) : null}

        <ShareNewsSheet item={shareItem} onClose={() => setShareItem(null)} />
      </View>
  );
}

export default function VBGGeoRiskScreen() {
  const navigation = useNavigation();
  return (
    <VbgScreen footer={<VbgFooter />}>
      <View style={styles.header}>
        <IconButton onPress={() => goBackOnce(navigation)}>
          <Svg width={9} height={15} viewBox="0 0 9 15"><Path d="M8 1L1.5 7.5 8 14" stroke={VBG.text} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
        </IconButton>
        <SectionLabel color={VBG.text} style={{fontSize: 12, letterSpacing: 2}}>GeoRisk Analysis</SectionLabel>
      </View>
      <GeoRiskPanel />
    </VbgScreen>
  );
}

function Chevron({open}: {open: boolean}) {
  return (
    <Svg width={9} height={9} viewBox="0 0 12 12" style={{transform: [{rotate: open ? '90deg' : '0deg'}]}}>
      <Path d="M3 1.5l5 4.5-5 4.5" stroke={VBG.textMute} strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function Seg({active, onPress, label}: {active: boolean; onPress: () => void; label: string}) {
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={[styles.seg, active ? styles.segOn : styles.segOff]}>
      <Text style={[styles.segText, {color: active ? '#fff' : VBG.textDim}]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: 4, paddingBottom: 16},
  body: {paddingHorizontal: 18, gap: 13},

  map: {height: 280},

  cardHead: {flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 12},
  searchRow: {flexDirection: 'row', gap: 9, alignItems: 'center'},
  input: {
    flex: 1, height: 46, borderRadius: 12, paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: VBG.hair2,
    color: VBG.text, fontSize: 13,
  },
  searchBtn: {
    width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: VBG.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  gpsBtn: {
    marginTop: 11, height: 46, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: VBG.hair2,
  },
  gpsBtnOn: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.4)'},
  gpsText: {fontSize: 12, fontWeight: '600', color: VBG.accentSoft, letterSpacing: 0.2},

  suggestBox: {marginTop: 8, borderRadius: 12, backgroundColor: 'rgba(13,17,25,0.98)', borderWidth: 1, borderColor: VBG.hair2, overflow: 'hidden'},
  suggestRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11},
  suggestBorder: {borderBottomWidth: 1, borderBottomColor: VBG.hair},
  suggestName: {fontSize: 13.5, fontWeight: '600', color: VBG.text, letterSpacing: -0.2},
  suggestFull: {fontSize: 10.5, color: VBG.textMute, marginTop: 2},

  paramLabel: {fontSize: 10, color: VBG.textMute, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 9},
  segRow: {flexDirection: 'row', gap: 9},
  seg: {flex: 1, height: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1},
  segOn: {backgroundColor: VBG.accent, borderColor: 'rgba(255,255,255,0.18)'},
  segOff: {backgroundColor: 'rgba(255,255,255,0.03)', borderColor: VBG.hair2},
  segText: {fontSize: 12.5, fontWeight: '700', letterSpacing: 0.2},

  runText: {fontSize: 11.5, fontWeight: '700', letterSpacing: 1.6, color: '#fff'},
  retrying: {fontSize: 10.5, color: VBG.textMute, textAlign: 'center', letterSpacing: 0.4},
  error: {fontSize: 11.5, color: '#FF8B8B', textAlign: 'center', paddingHorizontal: 10, lineHeight: 16},

  summaryHead: {marginBottom: 11},
  expandFoot: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 13, paddingTop: 11, borderTopWidth: 1, borderTopColor: VBG.hair},
  expandFootText: {fontSize: 10, color: VBG.textMute, fontWeight: '600', letterSpacing: 0.3},
  hint: {fontSize: 12, color: VBG.textMute, textAlign: 'center', lineHeight: 18, paddingHorizontal: 20, paddingVertical: 12},

  summary: {fontSize: 13, lineHeight: 19, color: VBG.textDim, letterSpacing: -0.1},
  scoreHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 15, marginBottom: 7},
  scoreLabel: {fontSize: 9.5, color: VBG.textMute, letterSpacing: 1, textTransform: 'uppercase'},
  scoreVal: {fontSize: 16, fontWeight: '700', color: VBG.text},
  scoreOf: {fontSize: 11, color: VBG.textMute, fontWeight: '500'},
  scoreTrack: {height: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden'},
  scoreFill: {height: '100%', borderRadius: 999},

  riskRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12},
  riskBorder: {borderBottomWidth: 1, borderBottomColor: VBG.hair},
  riskLeft: {flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1, minWidth: 0},
  riskRight: {flexDirection: 'row', alignItems: 'center', gap: 8},
  // Fixed-width, right-aligned badge slot so HIGH/MEDIUM/LOW all line up their
  // right edge in one column regardless of label width.
  riskBadgeSlot: {minWidth: 62, alignItems: 'flex-end'},
  riskChevron: {width: 12, alignItems: 'center', justifyContent: 'center'},
  riskDot: {width: 8, height: 8, borderRadius: 4, shadowOpacity: 0.8, shadowRadius: 5, shadowOffset: {width: 0, height: 0}},
  riskName: {fontSize: 13, fontWeight: '500', color: VBG.text, letterSpacing: -0.2},
  riskCount: {fontSize: 9, fontWeight: '700', color: VBG.accentSoft, backgroundColor: 'rgba(91,141,239,0.14)', borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden'},
  tapHint: {fontSize: 8.5, color: VBG.textMute, fontWeight: '500', letterSpacing: 0},

  newsWrap: {paddingHorizontal: 12, paddingBottom: 11, gap: 9},
  newsRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: VBG.hair},
  newsDot: {width: 6, height: 6, borderRadius: 3, marginTop: 5},
  newsShare: {marginTop: 1, paddingLeft: 2},
  newsTitle: {fontSize: 12, lineHeight: 16.5, color: VBG.textDim, letterSpacing: -0.1},
  newsMeta: {fontSize: 9.5, color: VBG.textMute, marginTop: 4},

  recRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  recText: {fontSize: 12.5, lineHeight: 17, color: VBG.textDim, flex: 1, letterSpacing: -0.05},
}));
