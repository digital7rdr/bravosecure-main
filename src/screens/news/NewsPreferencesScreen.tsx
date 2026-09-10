import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  StatusBar,
  Switch,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {alpha3} from '@utils/countryCodes';
import {Alert} from '@utils/alert';
import {
  NEWS_CATEGORIES,
  NEWS_COUNTRIES,
  MAX_SELECTED_COUNTRIES,
  loadNewsPrefs,
  saveNewsPrefs,
} from '@modules/news/newsPrefs';

type Country = (typeof NEWS_COUNTRIES)[number];

export default function NewsPreferencesScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  // Footer is the bottom-most element: while the IME is up (country search
  // focused) it pads by the overlap instead of the tab-bar/safe-area rule.
  const imeOverlap = useKeyboardOverlap();
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [countries, setCountries] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const [query, setQuery] = useState('');
  // Ordered ONCE at hydration — selected countries surface on top without
  // rows jumping around as the user toggles.
  const [orderedCountries, setOrderedCountries] = useState<Country[]>(NEWS_COUNTRIES);

  // Hydrate persisted prefs on mount so prior selections survive restarts.
  useEffect(() => {
    let cancelled = false;
    void loadNewsPrefs().then(prefs => {
      if (cancelled) {return;}
      const selected = new Set(prefs.countries);
      setCategories(new Set(prefs.categories));
      setCountries(selected);
      setOrderedCountries([
        ...NEWS_COUNTRIES.filter(c => selected.has(c.code)),
        ...NEWS_COUNTRIES.filter(c => !selected.has(c.code)),
      ]);
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, []);

  const savePrefs = async () => {
    await saveNewsPrefs({
      countries: NEWS_COUNTRIES.map(c => c.code).filter(c => countries.has(c)),
      categories: NEWS_CATEGORIES.map(c => c.id).filter(c => categories.has(c)),
    });
    navigation.goBack();
  };

  const toggleCategory = (id: string) => {
    setCategories(prev => {
      const next = new Set(prev);
      if (next.has(id)) {next.delete(id);} else {next.add(id);}
      return next;
    });
  };

  const toggleCountry = useCallback((code: string) => {
    setCountries(prev => {
      if (!prev.has(code) && prev.size >= MAX_SELECTED_COUNTRIES) {
        Alert.alert(
          'Country limit',
          `Your feed blends up to ${MAX_SELECTED_COUNTRIES} countries at a time. Switch one off to add another.`,
        );
        return prev;
      }
      const next = new Set(prev);
      if (next.has(code)) {next.delete(code);} else {next.add(code);}
      return next;
    });
  }, []);

  const visibleCountries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {return orderedCountries;}
    return orderedCountries.filter(
      // Match the code the user can SEE (alpha-3) as well as the alpha-2 the
      // row is keyed on. Without the first clause, switching the badge to
      // alpha-3 would have made searching "DZA" — the only code on screen —
      // return nothing.
      c => c.label.toLowerCase().includes(q)
        || alpha3(c.code).toLowerCase() === q
        || c.code.toLowerCase() === q,
    );
  }, [orderedCountries, query]);

  const renderCountry = useCallback(({item}: {item: Country}) => {
    const isOn = countries.has(item.code);
    const isGlobal = item.code === 'GLOBAL';
    return (
      <TouchableOpacity
        style={[styles.regionRow, isOn && styles.regionRowOn]}
        onPress={() => toggleCountry(item.code)}
        activeOpacity={0.85}>
        {isGlobal ? (
          <View style={[styles.regionIcon, {backgroundColor: isOn ? 'rgba(37,99,235,0.12)' : '#1E2D45'}]}>
            <Icon name="earth" size={14} color={isOn ? '#60A5FA' : '#64748B'} />
          </View>
        ) : (
          <View style={[styles.codeTag, {backgroundColor: isOn ? 'rgba(37,99,235,0.15)' : '#1E2D45', borderColor: isOn ? 'rgba(37,99,235,0.3)' : 'transparent'}]}>
            {/* alpha3 for DISPLAY only — `item.code` stays alpha-2 because it
                is the persisted preference and the /news/feed parameter. */}
            <Text style={[styles.codeText, {color: isOn ? '#60A5FA' : '#64748B'}]}>{alpha3(item.code)}</Text>
          </View>
        )}
        <Text style={[styles.regionLabel, !isOn && styles.regionLabelOff]}>{item.label}</Text>
        {/* Why the wrapper: RN's Android Switch is a native SwitchCompat, not a
            React view group, so pointerEvents set on the Switch itself is
            ignored and the native control eats the tap (with no onValueChange
            the tap then does nothing — the founder's dead-toggle bug). A View
            with pointerEvents="none" DOES block its subtree, so the tap lands
            on the row and there is still exactly one toggle source. */}
        <View pointerEvents="none" style={styles.switchWrap}>
          <Switch
            value={isOn}
            trackColor={{false: '#1E2D45', true: Colors.primary}}
            thumbColor="#FFF"
          />
        </View>
      </TouchableOpacity>
    );
  }, [countries, toggleCountry]);

  const listHeader = (
    <View style={styles.listHeader}>
      <Text style={styles.desc}>Pick the countries and categories you want news for. Your feed blends live coverage from every selection.</Text>

      {/* Categories */}
      <View>
        <Text style={styles.sectionLabel}>Categories</Text>
        <View style={styles.topicsWrap}>
          {NEWS_CATEGORIES.map(cat => {
            const isActive = categories.has(cat.id);
            return (
              <TouchableOpacity
                key={cat.id}
                style={[styles.topicChip, isActive && styles.topicChipActive]}
                onPress={() => toggleCategory(cat.id)}
                activeOpacity={0.8}>
                <Text style={[styles.topicText, isActive && styles.topicTextActive]}>{cat.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Countries */}
      <View>
        <View style={styles.countriesHead}>
          <Text style={[styles.sectionLabel, styles.sectionLabelTight]}>Countries</Text>
          <Text style={styles.countHint}>{countries.size}/{MAX_SELECTED_COUNTRIES} selected</Text>
        </View>
        <View style={styles.searchBox}>
          <Icon name="magnify" size={16} color="#64748B" />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search countries…"
            placeholderTextColor="#64748B"
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
              <Icon name="close-circle" size={16} color="#64748B" />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="arrow-left" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>News Preferences</Text>
        <View style={styles.headerSpacer} />
      </View>

      <FlatList
        data={visibleCountries}
        keyExtractor={c => c.code}
        renderItem={renderCountry}
        extraData={countries}
        ListHeaderComponent={listHeader}
        ItemSeparatorComponent={CountryGap}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No country matches “{query.trim()}”.</Text>
        }
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}
      />

      {/* Footer CTA */}
      <View style={[styles.footer, {paddingBottom: imeOverlap > 0 ? imeOverlap + 12 : bottomPad(20)}]}>
        <TouchableOpacity
          style={[styles.saveBtn, !hydrated && {opacity: 0.5}]}
          disabled={!hydrated}
          onPress={() => { void savePrefs(); }}
          activeOpacity={0.85}>
          <Text style={styles.saveBtnText}>SAVE PREFERENCES</Text>
          <Icon name="arrow-right" size={16} color="#FFF" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function CountryGap() {
  return <View style={{height: 8}} />;
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {flex: 1, fontSize: 14, fontWeight: '700', color: '#E2E8F0', textAlign: 'center', marginRight: 36},
  headerSpacer: {width: 36},

  // Capped + centered so unfolded/tablet widths don't stretch the rows.
  content: {paddingHorizontal: 16, paddingTop: 16, width: '100%', maxWidth: 760, alignSelf: 'center'},
  listHeader: {gap: 20, marginBottom: 12},

  desc: {fontSize: 12, color: '#94A3B8', lineHeight: 18},

  sectionLabel: {fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 2, marginBottom: 12},
  sectionLabelTight: {marginBottom: 0},
  countriesHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12},
  countHint: {fontSize: 10, fontWeight: '700', color: '#64748B', letterSpacing: 0.5},

  topicsWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  topicChip: {paddingHorizontal: 14, paddingVertical: 6, borderRadius: 99, borderWidth: 1.5, borderColor: '#1E2D45', backgroundColor: 'transparent'},
  topicChipActive: {backgroundColor: 'rgba(37,99,235,0.15)', borderColor: Colors.primary},
  topicText: {fontSize: 11, fontWeight: '700', color: '#64748B'},
  topicTextActive: {color: '#60A5FA'},

  searchBox: {flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', backgroundColor: '#0D1929', paddingHorizontal: 12},
  searchInput: {flex: 1, fontSize: 13, color: '#E2E8F0', paddingVertical: 10},

  regionRow: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', backgroundColor: '#0D1929'},
  regionRowOn: {borderColor: 'rgba(37,99,235,0.3)'},
  regionIcon: {width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  codeTag: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, flexShrink: 0, minWidth: 32, alignItems: 'center'},
  codeText: {fontSize: 10, fontWeight: '800'},
  regionLabel: {flex: 1, fontSize: 13, fontWeight: '700', color: '#E2E8F0'},
  regionLabelOff: {color: '#64748B'},
  switchWrap: {flexShrink: 0},

  emptyText: {fontSize: 12, color: '#64748B', textAlign: 'center', paddingVertical: 24},

  footer: {paddingHorizontal: 16, paddingTop: 8, backgroundColor: Colors.background},
  saveBtn: {backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  saveBtnText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.8},
}));
