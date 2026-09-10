import React, {useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

const RELATED = [
  {icon: 'lock', iconBg: 'rgba(34,197,94,0.1)', iconColor: '#4ade80', title: 'UAE Cybersecurity Framework V2.0 Issued', meta: 'UAE · 8 hrs ago'},
  {icon: 'airplane', iconBg: 'rgba(37,99,235,0.1)', iconColor: '#60A5FA', title: 'Emirates Orders 50 Boeing 777X', meta: 'UAE · 1 day ago'},
];

export default function NewsArticleScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const [bookmarked, setBookmarked] = useState(false);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* Floating header */}
      <View style={[styles.floatingHeader, {paddingTop: insets.top + 8}]}>
        <TouchableOpacity style={styles.floatBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="arrow-left" size={20} color="#E2E8F0" />
        </TouchableOpacity>
        <View style={styles.floatRight}>
          <TouchableOpacity style={styles.floatBtn} onPress={() => setBookmarked(b => !b)} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name={bookmarked ? 'bookmark' : 'bookmark-outline'} size={20} color={bookmarked ? Colors.primary : '#E2E8F0'} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.floatBtn} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="share-variant" size={20} color="#E2E8F0" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Scrollable content */}
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingBottom: 90}}>

        {/* Hero */}
        <View style={styles.hero}>
          {/* Simulated image with gradient */}
          <View style={styles.heroImg} />
          <View style={styles.heroOverlay} />
          {/* Breaking badge */}
          <View style={styles.breakingBadge}>
            <Text style={styles.breakingBadgeText}>Breaking Alert</Text>
          </View>
        </View>

        {/* Article body */}
        <View style={styles.body}>

          {/* Badges row */}
          <View style={styles.badgesRow}>
            <View style={styles.badgeBreaking}>
              <Text style={styles.badgeBreakingText}>BREAKING</Text>
            </View>
            <View style={styles.badgeRegion}>
              <Text style={styles.badgeRegionText}>AE</Text>
            </View>
            <View style={styles.badgeUAE}>
              <Text style={styles.badgeUAEText}>UAE</Text>
            </View>
            <View style={styles.badgeTrending}>
              <Icon name="trending-up" size={10} color="#FBBF24" />
              <Text style={styles.badgeTrendingText}>TRENDING</Text>
            </View>
            <Text style={styles.metaRight}>2 hrs ago · 4 min read</Text>
          </View>

          {/* Headline */}
          <Text style={styles.headline}>
            DIFC Records Highest Q1 Transaction Volume in 5 Years
          </Text>

          {/* Byline */}
          <View style={styles.bylineRow}>
            <View style={styles.bylineAvatar}>
              <Text style={styles.bylineAvatarText}>BN</Text>
            </View>
            <View style={styles.bylineText}>
              <Text style={styles.bylineName}>Bravo News Channel</Text>
              <Text style={styles.bylineSub}>Geographic Business Intelligence · 2 hrs ago</Text>
            </View>
            <View style={styles.verifiedBadge}>
              <Text style={styles.verifiedText}>VERIFIED</Text>
            </View>
          </View>

          {/* Standfirst */}
          <View style={styles.standfirst}>
            <Text style={styles.standfirstText}>
              Office and residential demand surges as Dubai cements its position as the MENA financial hub of record.
            </Text>
          </View>

          {/* Body paragraphs */}
          <View style={styles.bodyText}>
            <Text style={styles.para}>
              The Dubai International Financial Centre recorded AED 4.2 billion in real estate transactions during Q1 2025, the highest quarterly figure since 2020. Analysts point to increased HNW relocation from European markets and zero capital gains tax.
            </Text>
            <Text style={styles.para}>
              Grade-A office vacancy fell to 3.1%, tightening supply outlook. Developers EMAAR and Nakheel announced accelerated tower starts in the Gate District.
            </Text>
          </View>

          {/* Tags */}
          <View style={styles.tagsRow}>
            {['#REAL_ESTATE', '#DIFC', '#GCC-Intelligence'].map(tag => (
              <View key={tag} style={styles.tag}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
          </View>

          {/* Related Stories */}
          <View style={styles.relatedSection}>
            <Text style={styles.relatedLabel}>Related Stories</Text>
            {RELATED.map((r, idx) => (
              <TouchableOpacity key={idx} style={styles.relatedCard} activeOpacity={0.8}>
                <View style={[styles.relatedIcon, {backgroundColor: r.iconBg}]}>
                  <Icon name={r.icon} size={18} color={r.iconColor} />
                </View>
                <View style={styles.relatedText}>
                  <Text style={styles.relatedTitle}>{r.title}</Text>
                  <Text style={styles.relatedMeta}>{r.meta}</Text>
                </View>
                <Icon name="chevron-right" size={16} color="#334155" />
              </TouchableOpacity>
            ))}
          </View>

        </View>
      </ScrollView>

      {/* Bottom action bar */}
      <View style={[styles.bottomBar, {paddingBottom: bottomPad(8)}]}>
        <TouchableOpacity style={styles.briefingBtn} activeOpacity={0.85}>
          <Text style={styles.briefingBtnText}>Request Briefing</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.backBtn2} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Text style={styles.backBtn2Text}>Back</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  floatingHeader: {position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12},
  floatBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(10,15,30,0.6)'},
  floatRight: {flexDirection: 'row', gap: 8},

  scroll: {flex: 1},
  hero: {height: 260, position: 'relative'},
  heroImg: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#0D2240'},
  heroOverlay: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(10,15,30,0.65)'},
  breakingBadge: {position: 'absolute', top: 200, left: 16, backgroundColor: '#DC2626', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8},
  breakingBadgeText: {color: '#FFF', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase'},

  body: {paddingHorizontal: 16, paddingTop: 20, gap: 20},

  badgesRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6},
  badgeBreaking: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, backgroundColor: 'rgba(220,38,38,0.15)', borderWidth: 1, borderColor: 'rgba(220,38,38,0.3)'},
  badgeBreakingText: {color: '#F87171', fontSize: 9, fontWeight: '800', letterSpacing: 1},
  badgeRegion: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, backgroundColor: 'rgba(37,99,235,0.15)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.3)'},
  badgeRegionText: {color: '#93C5FD', fontSize: 9, fontWeight: '800', letterSpacing: 1},
  badgeUAE: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, backgroundColor: 'rgba(37,99,235,0.1)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.2)'},
  badgeUAEText: {color: '#60A5FA', fontSize: 9, fontWeight: '800', letterSpacing: 1},
  badgeTrending: {flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)'},
  badgeTrendingText: {color: '#FBBF24', fontSize: 9, fontWeight: '800', letterSpacing: 1},
  metaRight: {color: '#475569', fontSize: 11, marginLeft: 'auto'},

  headline: {color: '#FFF', fontSize: 21, fontWeight: '800', lineHeight: 28},

  bylineRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#1E2D45'},
  bylineAvatar: {width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center'},
  bylineAvatarText: {color: '#FFF', fontSize: 12, fontWeight: '700'},
  bylineText: {flex: 1},
  bylineName: {color: '#E2E8F0', fontSize: 12, fontWeight: '700'},
  bylineSub: {color: '#475569', fontSize: 11, marginTop: 1},
  verifiedBadge: {paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(37,99,235,0.1)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.2)'},
  verifiedText: {color: '#60A5FA', fontSize: 10, fontWeight: '700'},

  standfirst: {paddingHorizontal: 16, paddingVertical: 14, borderRadius: 12, backgroundColor: '#0D1929', borderLeftWidth: 3, borderLeftColor: Colors.primary},
  standfirstText: {color: '#E2E8F0', fontSize: 13, fontWeight: '600', lineHeight: 20},

  bodyText: {gap: 16},
  para: {color: '#CBD5E1', fontSize: 14, lineHeight: 22},

  tagsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  tag: {paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99, backgroundColor: '#1E2D45'},
  tagText: {color: '#94A3B8', fontSize: 11},

  relatedSection: {gap: 8},
  relatedLabel: {color: '#475569', fontSize: 10, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase'},
  relatedCard: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45'},
  relatedIcon: {width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  relatedText: {flex: 1},
  relatedTitle: {color: '#E2E8F0', fontSize: 12, fontWeight: '700', lineHeight: 17},
  relatedMeta: {color: '#475569', fontSize: 10, marginTop: 2},

  bottomBar: {paddingHorizontal: 16, paddingTop: 12, flexDirection: 'row', gap: 12, backgroundColor: Colors.background, borderTopWidth: 1, borderTopColor: '#1E2D45'},
  briefingBtn: {flex: 1, paddingVertical: 12, borderRadius: 12, backgroundColor: Colors.primary, alignItems: 'center', shadowColor: Colors.primary, shadowOffset: {width: 0, height: 4}, shadowOpacity: 0.35, shadowRadius: 14, elevation: 5},
  briefingBtnText: {color: '#FFF', fontSize: 13, fontWeight: '700'},
  backBtn2: {paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', alignItems: 'center', justifyContent: 'center'},
  backBtn2Text: {color: '#94A3B8', fontSize: 13, fontWeight: '700'},
}));
