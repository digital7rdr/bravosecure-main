import React, {useCallback, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {newsApi} from '@services/api';
import {useIntelFeed} from '@modules/news/useIntelFeed';
import {categoryLabel, countryLabel, loadNewsPrefs} from '@modules/news/newsPrefs';

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'NewsHub'>;

const PRIORITY_SHORT: Record<string, string> = {CRITICAL: 'CRIT', HIGH: 'HIGH', MEDIUM: 'MED', LOW: 'LOW'};

interface FeedPreviewItem { region: string; headline: string }

interface SectionCardProps {
  icon: string;
  iconBg: string;
  iconBorder: string;
  iconColor: string;
  title: string;
  sub: string;
  badge?: {label: string; color: string; bg: string; border: string};
  onPress: () => void;
  browseLabel: string;
  children?: React.ReactNode;
}

function SectionCard({icon, iconBg, iconBorder, iconColor, title, sub, badge, onPress, browseLabel, children}: SectionCardProps) {
  return (
    <TouchableOpacity style={styles.sectionCard} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.sectionCardBody}>
        <View style={styles.sectionCardHeader}>
          <View style={styles.sectionLeft}>
            <View style={[styles.sectionIconWrap, {backgroundColor: iconBg, borderColor: iconBorder}]}>
              <Icon name={icon} size={16} color={iconColor} />
            </View>
            <View>
              <Text style={styles.sectionTitle}>{title}</Text>
              <Text style={styles.sectionSub}>{sub}</Text>
            </View>
          </View>
          {badge && (
            <View style={[styles.badgeWrap, {backgroundColor: badge.bg, borderColor: badge.border}]}>
              <Text style={[styles.badgeText, {color: badge.color}]}>{badge.label}</Text>
            </View>
          )}
        </View>
        {children}
      </View>
      <View style={styles.browseBtnRow}>
        <Text style={styles.browseLabel}>{browseLabel}</Text>
        <Icon name="chevron-right" size={16} color="#60A5FA" />
      </View>
    </TouchableOpacity>
  );
}

/**
 * The News-hub BODY — the filter banner + the My Feed / Bravo Feed cards.
 *
 * Split out (N1) so the persistent-footer Messenger home can render it INLINE as
 * the `News` tab (`embedded`) without unmounting the bar, while the pushed
 * `NewsHub` route (deep-link / workspace-shell News tab) keeps rendering it
 * IDENTICALLY through the default export below. `embedded` drops the outer
 * safe-area padding + StatusBar and the back chevron (a tab has nothing to pop);
 * `bottomPad` clears the persistent bar. The `activeTab === 'News' &&` host
 * guard UNMOUNTS this on tab switch, so the intel fetch aborts (no interval).
 */
export function NewsHubBody({embedded = false, bottomPad = 0}: {embedded?: boolean; bottomPad?: number}) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [prefTags, setPrefTags] = useState<string[]>([]);
  const [feedPreview, setFeedPreview] = useState<FeedPreviewItem[]>([]);
  // Live intel preview from the same aggregator the IntelFeed screen uses;
  // sources === 0 means the demo fallback — never surface that as real intel.
  const intel = useIntelFeed('ALL');
  const wirePreview = intel.sources > 0 ? intel.items.slice(0, 2) : [];

  // Refresh on focus so a Preferences save retunes the card on the way back.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void loadNewsPrefs().then(async prefs => {
        if (cancelled) {return;}
        setPrefTags([
          ...prefs.countries.map(countryLabel),
          ...prefs.categories.map(categoryLabel),
        ].slice(0, 6));
        try {
          const {data} = await newsApi.getFeed({
            countries: prefs.countries.join(','),
            categories: prefs.categories.join(','),
          });
          if (cancelled) {return;}
          const rows = Array.isArray(data?.articles) ? data.articles : [];
          setFeedPreview(rows.slice(0, 2).map(r => ({
            region: String(r.region ?? 'GLOBAL').toUpperCase(),
            headline: String(r.title ?? ''),
          })));
        } catch {/* preview is best-effort — card still opens the feed */}
      });
      return () => { cancelled = true; };
    }, []),
  );

  return (
    <View style={[styles.root, !embedded && {paddingTop: insets.top}]}>
      {!embedded && <StatusBar barStyle="light-content" backgroundColor={Colors.background} />}

      {/* Header */}
      <View style={styles.header}>
        {/* UI corrections 2026-08-15 item 07 — this screen is now ALSO the root
            of the workspace shell's News tab, where there is nothing to pop. An
            unconditional chevron there dispatches a GO_BACK that bubbles to the
            tab router and moves the user somewhere they did not ask to go; on
            the pushed messenger-stack path it is still a real back. Gate it on
            canGoBack() and render the spacer otherwise — the same pattern
            AgentTypeSelectScreen uses, pinned by backAffordanceGuards. */}
        {/* N1 — force the spacer when embedded as the persistent-bar News tab:
            canGoBack() can be true (MessengerHome was pushed) and a back there
            would pop MessengerHome, not the tab. */}
        {!embedded && navigation.canGoBack() ? (
          <TouchableOpacity style={styles.backBtn} activeOpacity={0.7} onPress={() => goBackOnce(navigation)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="chevron-left" size={22} color="#B8C7E0" />
          </TouchableOpacity>
        ) : <View style={styles.backBtn} />}
        <View style={{flex: 1}}>
          <Text style={styles.headerEyebrow}>Bravo Messenger</Text>
          <Text style={styles.headerTitle}>News Feed</Text>
        </View>
        <TouchableOpacity style={styles.tuneBtn} activeOpacity={0.7} onPress={() => navigation.navigate('NewsPreferences')} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="tune-variant" size={20} color="#94A3B8" />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 120 + bottomPad}]}>

        {/* NEWS FILTER — moved here from the Regional feed (founder
            2026-08-09). It sits above BOTH cards because the preferences it
            edits shape both feeds, so it belongs before the choice rather than
            one level inside one of them. */}
        <TouchableOpacity
          style={styles.filterBanner}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="News filter — categories and countries"
          onPress={() => navigation.navigate('NewsPreferences')}>
          <View style={styles.filterBannerIcon}>
            <Icon name="tune-variant" size={18} color="#60A5FA" />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={styles.filterBannerTitle}>News Filter</Text>
            <Text style={styles.filterBannerDesc} numberOfLines={2}>
              Filter news by your preferred categories and countries, and monitor relevant signals on the Intel Map.
            </Text>
          </View>
          <Icon name="chevron-right" size={18} color="#60A5FA" />
        </TouchableOpacity>

        {/* My Feed — ordered ABOVE Bravo Feed (founder 2026-08-09): the
            personalised feed is the one shaped by the filter directly above
            it, so the two read as a pair. */}
        <SectionCard
          icon="tune-variant"
          iconBg="rgba(37,99,235,0.15)"
          iconBorder="rgba(37,99,235,0.3)"
          iconColor="#60A5FA"
          title="My Feed"
          sub="Personalised by your preferences"
          onPress={() => navigation.navigate('NewsFeed')}
          browseLabel="OPEN MY FEED">
          {/* Preference tags — the saved country/category selection */}
          {prefTags.length > 0 && (
            <View style={styles.prefTags}>
              {prefTags.map(tag => (
                <View key={tag} style={styles.prefTag}>
                  <Text style={styles.prefTagText}>{tag}</Text>
                </View>
              ))}
            </View>
          )}
          {feedPreview.length > 0 && (
            <View style={styles.miniList}>
              {feedPreview.map((item, idx) => (
                <View key={idx} style={[styles.miniItem, idx === feedPreview.length - 1 && {borderBottomWidth: 0}]}>
                  <View style={styles.regionBadge}>
                    <Text style={styles.regionBadgeText}>{item.region}</Text>
                  </View>
                  <Text style={styles.miniHeadline} numberOfLines={1}>{item.headline}</Text>
                </View>
              ))}
            </View>
          )}
        </SectionCard>

        {/* Bravo Feed */}
        <SectionCard
          icon="earth"
          iconBg="rgba(37,99,235,0.15)"
          iconBorder="rgba(37,99,235,0.3)"
          iconColor="#60A5FA"
          title="Bravo Feed"
          sub="Global News & Information · OSINT · Signals"
          badge={{label: 'LIVE', color: '#4ade80', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.3)'}}
          onPress={() => navigation.navigate('IntelFeed')}
          browseLabel="OPEN BRAVO FEED">
          {wirePreview.length > 0 && (
            <View style={styles.miniList}>
              {wirePreview.map((item, idx) => (
                <View key={item.id} style={[styles.miniItem, idx === wirePreview.length - 1 && {borderBottomWidth: 0}]}>
                  <View style={[styles.miniLevelBadge, {backgroundColor: item.priorityBg, borderColor: item.priorityColor + '4D'}]}>
                    <Text style={[styles.miniLevelText, {color: item.priorityColor}]}>{PRIORITY_SHORT[item.priority] ?? item.priority}</Text>
                  </View>
                  <Text style={styles.miniHeadline} numberOfLines={1}>{item.headline}</Text>
                </View>
              ))}
            </View>
          )}
        </SectionCard>

        {/* B-91 M1 R8 — the Advertisements and Bravo Services sections and
            the Virtual Bodyguard CTA are gone: the News Feed carries news
            and intelligence ONLY (spec p.11). Advertising lives solely in
            the pinned sponsored slot on the Chat list; other products are
            reached via Profile → Switch Dashboard. */}
      </ScrollView>
    </View>
  );
}

/** The pushed `NewsHub` route (deep-link / workspace-shell News tab) — the
 *  standalone screen is the body under its own safe-area + back chevron. */
export default function NewsHubScreen() {
  return <NewsHubBody />;
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1E2D45', backgroundColor: Colors.background},
  headerEyebrow: {color: '#334155', fontSize: 9, fontWeight: '700', letterSpacing: 3, textTransform: 'uppercase'},
  headerTitle: {color: '#F1F5F9', fontSize: 20, fontWeight: '800', letterSpacing: -0.3, marginTop: 2},
  tuneBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 4},

  // Capped + centered so unfolded/tablet widths don't stretch the cards.
  content: {paddingHorizontal: 16, paddingTop: 16, gap: 12, width: '100%', maxWidth: 760, alignSelf: 'center'},

  // News filter entry — moved here from NewsFeedScreen (founder 2026-08-09).
  // The horizontal margins the banner carried there are dropped: this
  // container already pads 16 and gaps 12 between cards.
  filterBanner: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, paddingHorizontal: 14, borderRadius: 14, backgroundColor: 'rgba(37,99,235,0.10)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.35)'},
  filterBannerIcon: {width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(37,99,235,0.15)', flexShrink: 0},
  filterBannerTitle: {color: '#93B8FF', fontSize: 12, fontWeight: '800', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 2},
  filterBannerDesc: {color: '#94A3B8', fontSize: 11, lineHeight: 15},

  sectionCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  sectionCardBody: {paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12},
  sectionCardHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10},
  sectionLeft: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1},
  sectionIconWrap: {width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1},
  sectionTitle: {color: '#F1F5F9', fontSize: 13, fontWeight: '800'},
  sectionSub: {color: '#475569', fontSize: 10, marginTop: 1},
  badgeWrap: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, borderWidth: 1},
  badgeText: {fontSize: 9, fontWeight: '800', letterSpacing: 1},

  miniList: {gap: 0},
  miniItem: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  miniLevelBadge: {paddingHorizontal: 4, paddingVertical: 1, borderRadius: 2, borderWidth: 1, flexShrink: 0},
  miniLevelText: {fontSize: 7, fontWeight: '800', letterSpacing: 1},
  miniHeadline: {color: '#CBD5E1', fontSize: 11, fontWeight: '600', flex: 1},

  prefTags: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8},
  prefTag: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, backgroundColor: 'rgba(37,99,235,0.1)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.25)'},
  prefTagText: {color: '#93C5FD', fontSize: 9, fontWeight: '700', letterSpacing: 0.4},
  regionBadge: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: 'rgba(37,99,235,0.15)', flexShrink: 0},
  regionBadgeText: {color: '#93C5FD', fontSize: 8, fontWeight: '800'},

  cardDesc: {color: '#475569', fontSize: 11, lineHeight: 17},

  browseBtnRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: 1, borderTopColor: '#1E2D45'},
  browseLabel: {color: '#60A5FA', fontSize: 11, fontWeight: '800', letterSpacing: 0.4},

}));
