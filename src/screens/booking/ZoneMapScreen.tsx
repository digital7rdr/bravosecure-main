/**
 * Booking · Step 01 — Select Location (Zone)
 *
 * Premium redesign (Bravo "Select Zone" design handoff): obsidian/cobalt
 * palette, a stylised live map card with an Abu Dhabi pin + amber CPO
 * availability badge, country zone rows with live "CPOs online" status,
 * and a gradient Continue CTA.
 *
 * Data layer is unchanged from the original: a static city-zone seed,
 * live per-region CPO counts from `bookingApi.regionsAvailability()`,
 * booking-draft update on continue, then navigate to ServiceType.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  ScrollView,
  LayoutAnimation,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore} from '@store/bookingStore';
import {bookingApi, vbgApi} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {VbgKeyPointsMap} from '@screens/vbg/VbgKeyPointsMap';
import {useVbgLocation} from '@screens/vbg/useVbgLocation';
import {composeZoneCountries, type ZoneCountry} from './zoneCountries';
import {alpha3} from '@utils/countryCodes';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ZoneMap'>;

// Design tokens (Bravo "Select Zone" handoff — obsidian/cobalt premium).
// Kept inline so this screen matches the mockup exactly; the older
// Command-Navy theme isn't applied here on purpose.
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentGlow: 'rgba(91,141,239,0.35)',
  signal:     '#4ADE80',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

interface Region {
  code: string;     // dispatch key — matches region_code across the whole stack, DO NOT change
  badge: string;    // B-90 T-07 — 3-letter DISPLAY code shown on the tile (never sent to the API)
  name: string;     // full label, e.g. "UAE — Dubai, Abu Dhabi, Sharjah"
  country: string;  // e.g. "UAE"
  cities: string;   // e.g. "Dubai, Abu Dhabi, Sharjah"
  cpos: number;
  available: boolean;
}

// Founder 2026-08-01 — ONLY UAE + South Africa are selectable zones; every
// other country renders as an inactive "Coming Soon" row (see
// zoneCountries.ts). Both actives stay selectable regardless of the live
// availability flag (B-93 rule — launched even before the CPO pool is
// staffed); `cpos` still comes live from regionsAvailability.
// Badge note: "SA" is Saudi's dispatch code, so South Africa displays "SA"
// while its region_code stays ZA (B-90 T-07 display/dispatch split).
const REGION_SEED: Region[] = [
  {code: 'AE', badge: 'UAE', name: 'UAE — Dubai, Abu Dhabi, Sharjah',        country: 'UAE',          cities: 'Dubai, Abu Dhabi, Sharjah', cpos: 0, available: true},
  {code: 'ZA', badge: 'SA',  name: 'South Africa — Johannesburg, Cape Town', country: 'South Africa', cities: 'Johannesburg, Cape Town',   cpos: 0, available: true},
];

// Map-card centres when no GPS fix is available yet.
const ZONE_CENTRES: Record<string, {lat: number; lng: number}> = {
  AE: {lat: 24.4539, lng: 54.3773},   // Abu Dhabi
  ZA: {lat: -26.2041, lng: 28.0473},  // Johannesburg
};

function ZoneRow({region, selected, loaded, onPress}: {region: Region; selected: boolean; loaded: boolean; onPress: () => void}) {
  const live = region.available;
  return (
    <TouchableOpacity
      activeOpacity={live ? 0.85 : 1}
      onPress={live ? onPress : undefined}
      accessibilityRole="button"
      accessibilityState={{selected, disabled: !live}}
      accessibilityLabel={`${region.country}, ${live ? 'live' : 'on request'}`}
      style={[
        s.row,
        selected ? s.rowSelected : s.rowIdle,
        !live && s.rowDisabled,
      ]}>
      {selected && <View style={s.rowTopLight} />}

      {/* code tile */}
      {selected ? (
        <LinearGradient
          colors={['#6E9BF5', D.accentDeep]}
          start={{x: 0.15, y: 0}}
          end={{x: 0.85, y: 1}}
          style={s.codeTile}>
          <Text style={[s.codeText, {color: '#fff'}]}>{region.badge}</Text>
        </LinearGradient>
      ) : (
        <View style={[s.codeTile, s.codeTileIdle]}>
          <Text style={[s.codeText, {color: D.textMute}]}>{region.badge}</Text>
        </View>
      )}

      <View style={s.rowInfo}>
        {/* B-680/FS-16: two sibling Texts in a row — the country keeps intrinsic
            width (the zone choice must stay readable), the city list yields. */}
        <View style={{flexDirection: 'row', alignItems: 'baseline', minWidth: 0}}>
          <Text numberOfLines={1} style={[s.rowTitle, {color: live ? D.text : D.textDim, flexShrink: 0, maxWidth: '72%'}]}>{region.country}</Text>
          <Text numberOfLines={1} style={[s.rowTitle, s.rowCities, {flexShrink: 1, minWidth: 0}]}> — {region.cities}</Text>
        </View>
        <View style={s.rowStatus}>
          {live ? (
            <>
              <View style={s.dot} />
              <Text style={s.statusLive}>{loaded ? `${region.cpos} CPOs online` : 'Checking…'}</Text>
            </>
          ) : (
            <Text style={s.statusSoon}>ON REQUEST</Text>
          )}
        </View>
      </View>

      {live && (
        <View style={[s.chev, selected ? s.chevSelected : s.chevIdle]}>
          <Icon name="chevron-right" size={16} color={selected ? '#A9C5FF' : D.textMute} />
        </View>
      )}
    </TouchableOpacity>
  );
}

/**
 * Founder 2026-08-01 — the stylised grid map "doesn't display any
 * information": replaced with the SAME live Mapbox map the VBG dashboard
 * uses (VbgKeyPointsMap), centred on the user's fix, WITHOUT key points
 * (plain chrome: no HEATMAP chip). The amber CPO badge stays on top.
 */
function LiveMapCard({centre, cpoLabel}: {centre: {lat: number; lng: number}; cpoLabel: string}) {
  return (
    <View style={s.mapWrap}>
      <VbgKeyPointsMap centre={centre} points={[]} plain style={s.liveMap} />
      <View style={s.cpoBadge} pointerEvents="none">
        <Icon name="star-four-points" size={13} color={D.amber} />
        <Text numberOfLines={1} style={s.cpoBadgeText}>{cpoLabel}</Text>
      </View>
    </View>
  );
}

/** Collapsed-by-default country dropdown (Active / Coming Soon). */
function Dropdown({title, count, open, onToggle, children}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={s.dd}>
      <TouchableOpacity
        style={s.ddHead}
        onPress={onToggle}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityState={{expanded: open}}
        accessibilityLabel={`${title}, ${count} countries`}>
        <Text style={s.ddTitle}>{title}</Text>
        <View style={s.ddRight}>
          <Text style={s.ddCount}>{count}</Text>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={17} color={D.textMute} />
        </View>
      </TouchableOpacity>
      {open ? <View style={s.ddBody}>{children}</View> : null}
    </View>
  );
}

/** Inactive country row — name + "Coming Soon", never selectable. */
function SoonRow({country}: {country: ZoneCountry}) {
  return (
    <View style={s.soonRow} accessibilityLabel={`${country.label}, on request`}>
      <View style={s.soonTile}>
        <Text style={s.soonTileText}>{alpha3(country.code)}</Text>
      </View>
      <Text numberOfLines={1} style={s.soonName}>{country.label}</Text>
      <Text style={s.statusSoon}>ON REQUEST</Text>
    </View>
  );
}

export default function ZoneMapScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const updateDraft = useBookingStore(st => st.updateDraft);
  const draftCode = useBookingStore(st => st.draft.zone_code);

  const [selectedCode, setSelectedCode] = useState<string>(draftCode || 'AE');
  const [regions, setRegions] = useState<Region[]>(REGION_SEED);
  const [loaded, setLoaded] = useState(false);
  // Founder 2026-08-01 — dropdowns start COLLAPSED; only the located
  // country's row is always visible.
  const [activeOpen, setActiveOpen] = useState(false);
  const [soonOpen, setSoonOpen] = useState(false);
  const touchedRef = useRef(false);

  // Live map centre + current-country resolution (same GPS + cached server
  // reverse-geocode stack as the VBG screens).
  const {fix} = useVbgLocation();
  const [myCountry, setMyCountry] = useState<string | null>(null);
  useEffect(() => {
    if (!fix || myCountry) {return;}
    let cancelled = false;
    vbgApi.geocode({lat: fix.lat, lng: fix.lng})
      .then(res => {
        if (cancelled) {return;}
        const iso = res.data.country?.toUpperCase() ?? null;
        setMyCountry(iso);
        // Default the selection to the user's own country when it is active
        // and they haven't picked anything themselves yet.
        if (iso && !touchedRef.current && !draftCode && REGION_SEED.some(r => r.code === iso)) {
          setSelectedCode(iso);
        }
      })
      .catch(() => {/* country stays unknown — dropdowns still work */});
    return () => { cancelled = true; };
  }, [fix, myCountry, draftCode]);

  useEffect(() => {
    let cancelled = false;
    bookingApi.regionsAvailability()
      .then(res => {
        if (cancelled) {return;}
        const live = new Map(res.data.map(r => [r.code, r]));
        setRegions(REGION_SEED.map(seed => {
          const v = live.get(seed.code);
          if (!v) {return seed;}
          // Founder rule: the two launched zones STAY selectable regardless
          // of the availability flag; only the live CPO count is adopted.
          return {...seed, cpos: v.cpos_available};
        }));
        setLoaded(true);
      })
      .catch(() => { if (!cancelled) {setLoaded(true);} /* keep seed; better than blank */ });
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(
    () => regions.find(r => r.code === selectedCode) ?? regions[0],
    [regions, selectedCode],
  );

  // Country groups: located country always on top, actives + coming-soon
  // hidden inside their dropdowns (zoneCountries.ts).
  const groups = useMemo(() => composeZoneCountries(myCountry), [myCountry]);
  const liveCount = regions.length;
  const soonCount = groups.soon.length + (groups.current && !groups.current.active ? 1 : 0);

  const selectZone = (code: string) => {
    touchedRef.current = true;
    setSelectedCode(code);
  };
  const toggle = (which: 'active' | 'soon') => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (which === 'active') {setActiveOpen(o => !o);} else {setSoonOpen(o => !o);}
  };

  const handleContinue = () => {
    if (!selected.available) {return;}
    updateDraft({zone_code: selected.code, zone_label: selected.name, region: selected.code});
    navigation.navigate('ServiceType');
  };

  const cpoLabel = selected.available
    ? `${selected.cpos} CPOS AVAILABLE · ${selected.badge}`
    : `ON REQUEST · ${selected.badge}`;
  const mapCentre = fix ?? ZONE_CENTRES[selectedCode] ?? ZONE_CENTRES.AE;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.back}
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.title}>Select Location</Text>
          <Text numberOfLines={1} ellipsizeMode="tail" style={s.subTitle}>STEP 1 · CHOOSE OPERATING ZONE</Text>
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 140}}
        showsVerticalScrollIndicator={false}>
        <LiveMapCard centre={mapCentre} cpoLabel={cpoLabel} />

        <View style={s.sectionRow}>
          <Text style={s.sectionLabel}>AVAILABLE ZONES</Text>
          <Text style={s.sectionMeta}>{liveCount} LIVE · {soonCount} ON REQUEST</Text>
        </View>

        <View style={{gap: 11}}>
          {/* Located country — ALWAYS visible (founder rule). Active → a
              normal selectable zone row; not yet covered → Coming Soon. */}
          {groups.current ? (
            <View>
              <Text style={s.youAreHere}>YOUR LOCATION</Text>
              {groups.current.active ? (
                <ZoneRow
                  region={regions.find(r => r.code === groups.current!.code) ?? regions[0]}
                  selected={groups.current.code === selectedCode}
                  loaded={loaded}
                  onPress={() => selectZone(groups.current!.code)}
                />
              ) : (
                <SoonRow country={groups.current} />
              )}
            </View>
          ) : null}

          <Dropdown
            title="Countries on Demand"
            count={groups.active.length + (groups.current?.active ? 1 : 0)}
            open={activeOpen}
            onToggle={() => toggle('active')}>
            <View style={{gap: 11}}>
              {groups.active.map(c => {
                const region = regions.find(r => r.code === c.code);
                return region ? (
                  <ZoneRow
                    key={c.code}
                    region={region}
                    selected={c.code === selectedCode}
                    loaded={loaded}
                    onPress={() => selectZone(c.code)}
                  />
                ) : null;
              })}
              {groups.active.length === 0 ? (
                <Text style={s.ddEmpty}>Your country is the only active zone right now.</Text>
              ) : null}
            </View>
          </Dropdown>

          <Dropdown
            title="Countries on Request"
            count={groups.soon.length}
            open={soonOpen}
            onToggle={() => toggle('soon')}>
            <View style={{gap: 7}}>
              {groups.soon.map(c => <SoonRow key={c.code} country={c} />)}
            </View>
          </Dropdown>
        </View>
      </ScrollView>

      {/* ── Footer CTA ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        <TouchableOpacity
          activeOpacity={selected.available ? 0.9 : 1}
          disabled={!selected.available}
          onPress={handleContinue}>
          <LinearGradient
            colors={selected.available ? ['#6E9BF5', D.accent, D.accentDeep] : ['#27324A', '#1C2436']}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.cta, !selected.available && s.ctaDisabled]}>
            <Text style={s.ctaText}>Continue</Text>
            <Icon name="arrow-right" size={19} color="#fff" />
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
  },
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  title: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  subTitle: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  scroll: {flex: 1},

  // Live map card (VBG map embed, plain chrome)
  mapWrap: {
    height: 218, borderRadius: 22,
    shadowColor: '#000', shadowOpacity: 0.34, shadowRadius: 18, shadowOffset: {width: 0, height: 12}, elevation: 8,
  },
  liveMap: {height: 218, borderRadius: 22},

  // CPO badge
  cpoBadge: {
    position: 'absolute', bottom: 16, alignSelf: 'center', maxWidth: '86%',
    flexDirection: 'row', alignItems: 'center', gap: 9,
    paddingVertical: 9, paddingHorizontal: 16, borderRadius: 999,
    backgroundColor: 'rgba(245,181,68,0.10)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.45)',
  },
  cpoBadgeText: {fontFamily: D.fMono, fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: D.amber},

  // Section label
  sectionRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, marginBottom: 12, paddingHorizontal: 2},
  sectionLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, color: D.textDim},
  sectionMeta: {fontFamily: D.fMono, fontSize: 9, letterSpacing: 1, color: D.textMute},

  // Zone row
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 15, borderRadius: 18, overflow: 'hidden',
  },
  rowIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  rowSelected: {
    backgroundColor: 'rgba(16,26,46,0.9)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.5)',
    shadowColor: '#14285A', shadowOpacity: 0.34, shadowRadius: 16, shadowOffset: {width: 0, height: 12}, elevation: 8,
  },
  rowDisabled: {opacity: 0.62},
  rowTopLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(120,160,255,0.35)'},

  codeTile: {
    width: 50, height: 50, borderRadius: 14, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  codeTileIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  codeText: {fontFamily: D.fBold, fontSize: 13, letterSpacing: 0.5},

  rowInfo: {flex: 1, minWidth: 0},
  rowTitle: {fontFamily: D.fBold, fontSize: 15, letterSpacing: -0.2},
  rowCities: {color: D.textMute, fontFamily: D.fSemi},
  rowStatus: {flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 5},
  dot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: D.signal,
    shadowColor: D.signal, shadowOpacity: 1, shadowRadius: 7, shadowOffset: {width: 0, height: 0}, elevation: 3,
  },
  statusLive: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 0.4, color: D.signal},
  statusSoon: {
    flexShrink: 1,
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1, color: D.textMute,
    paddingVertical: 2, paddingHorizontal: 8, borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    overflow: 'hidden',
  },

  chev: {
    width: 28, height: 28, borderRadius: 14, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  chevIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  chevSelected: {backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)'},

  // Located-country tag
  youAreHere: {
    fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1.8,
    color: D.textMute, marginBottom: 7, marginLeft: 2,
  },

  // Country dropdowns
  dd: {borderRadius: 18, borderWidth: 1, borderColor: D.hair, backgroundColor: 'rgba(255,255,255,0.022)', overflow: 'hidden'},
  ddHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 15},
  ddTitle: {fontFamily: D.fBold, fontSize: 14, letterSpacing: -0.1, color: D.text},
  ddRight: {flexDirection: 'row', alignItems: 'center', gap: 8},
  ddCount: {
    fontFamily: D.fMono, fontSize: 10, fontWeight: '700', color: D.textDim,
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    overflow: 'hidden',
  },
  ddBody: {paddingHorizontal: 11, paddingBottom: 12},
  ddEmpty: {fontFamily: D.fSemi, fontSize: 11.5, color: D.textMute, paddingHorizontal: 5, paddingBottom: 4},

  // Coming-soon country row (inactive, never selectable)
  soonRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.018)', borderWidth: 1, borderColor: D.hair,
    opacity: 0.72,
  },
  soonTile: {
    width: 36, height: 36, borderRadius: 11, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  soonTileText: {fontFamily: D.fBold, fontSize: 11, letterSpacing: 0.5, color: D.textMute},
  soonName: {flex: 1, minWidth: 0, fontFamily: D.fSemi, fontSize: 13.5, letterSpacing: -0.1, color: D.textDim},

  // CTA
  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaDisabled: {borderColor: D.hair2, shadowOpacity: 0, elevation: 0},
  ctaText: {fontFamily: D.fBold, fontSize: 16.5, letterSpacing: 0.3, color: '#fff'},
}));
