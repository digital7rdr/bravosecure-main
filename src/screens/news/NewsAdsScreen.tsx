import React, {useEffect, useRef, useState} from 'react';
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
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type TabType = 'cyber' | 'jv';

const CYBER_APPS = [
  {
    id: 'mcafee',
    name: 'McAfee Total Protection',
    sub: 'Full-device security · 5 devices',
    price: 'AED 749/yr',
    rating: 4.6,
    stars: 5,
    badge: 'FEATURED',
    badgeColor: '#4ADE80',
    badgeBg: 'rgba(34,197,94,0.15)',
    badgeBorder: 'rgba(34,197,94,0.3)',
    icon: 'shield-check',
    iconColor: '#60A5FA',
    iconBg: 'rgba(37,99,235,0.15)',
    iconBorder: 'rgba(37,99,235,0.25)',
  },
  {
    id: 'nordvpn',
    name: 'NordVPN Enterprise',
    sub: 'Encrypted VPN · Business plan',
    price: 'AED 280/yr',
    rating: 4.8,
    stars: 4,
    badge: 'POPULAR',
    badgeColor: '#C4B5FD',
    badgeBg: 'rgba(124,58,237,0.15)',
    badgeBorder: 'rgba(124,58,237,0.3)',
    icon: 'key-variant',
    iconColor: '#818CF8',
    iconBg: 'rgba(99,102,241,0.15)',
    iconBorder: 'rgba(99,102,241,0.25)',
  },
  {
    id: 'malwarebytes',
    name: 'Malwarebytes Teams',
    sub: 'Threat detection · endpoint',
    price: 'AED 220/yr',
    rating: 4.5,
    stars: 4,
    badge: 'EDR',
    badgeColor: '#F87171',
    badgeBg: 'rgba(239,68,68,0.12)',
    badgeBorder: 'rgba(239,68,68,0.25)',
    icon: 'bug-outline',
    iconColor: '#F87171',
    iconBg: 'rgba(239,68,68,0.12)',
    iconBorder: 'rgba(239,68,68,0.2)',
  },
];

const JV_ADVERTS = [
  {
    id: 'uae',
    flag: '🇦🇪',
    category: 'REAL ESTATE',
    catColor: '#60A5FA',
    catBg: 'rgba(37,99,235,0.15)',
    region: 'AE · Dubai',
    title: 'DIFC Grade-A Office Space',
    sub: 'Premium serviced offices from AED 18,000/mo. Zero tax.',
  },
  {
    id: 'ksa',
    flag: '🇸🇦',
    category: 'ENTERPRISE',
    catColor: '#FBBF24',
    catBg: 'rgba(245,158,11,0.12)',
    region: 'SA · Riyadh',
    title: 'NEOM Business Zone Early Entry',
    sub: 'Founding partner licenses — government-backed incentives.',
  },
  {
    id: 'uk',
    flag: '🇬🇧',
    category: 'JOINT VENTURE',
    catColor: '#818CF8',
    catBg: 'rgba(99,102,241,0.15)',
    region: 'GB · London',
    title: 'Mayfair Security Advisory JV Open',
    sub: 'UK-licensed firms invited to JV with Bravo for GCC clients.',
  },
  {
    id: 'ea',
    flag: '🌍',
    category: 'PARTNERSHIP',
    catColor: '#4ADE80',
    catBg: 'rgba(34,197,94,0.12)',
    region: 'East Africa',
    title: 'Regional Intelligence Network — Partner Seats',
    sub: 'Ground-level OSINT partner positions in East Africa for Bravo GCC clients.',
  },
];

export default function NewsAdsScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<TabType>('cyber');
  const [offerStates, setOfferStates] = useState<Record<string, boolean>>({});

  // Track pending reset timers so we can clear them on unmount — otherwise
  // navigating away within 2s fires setState on an unmounted component.
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { timersRef.current.forEach(clearTimeout); }, []);

  const handleOffer = (id: string) => {
    setOfferStates(prev => ({...prev, [id]: true}));
    const t = setTimeout(() => setOfferStates(prev => ({...prev, [id]: false})), 2000);
    timersRef.current.push(t);
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="arrow-left" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {activeTab === 'cyber' ? 'Commercial Adverts' : 'GEO JV Adverts'}
        </Text>
        <View style={styles.partnerBadge}>
          <Text style={styles.partnerText}>PARTNER</Text>
        </View>
      </View>

      {/* Tab switcher */}
      <View style={styles.tabSwitcher}>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'cyber' && styles.tabBtnActive]}
          onPress={() => setActiveTab('cyber')}
          activeOpacity={0.8}>
          <Text style={[styles.tabBtnText, activeTab === 'cyber' && styles.tabBtnTextActive]}>
            CYBER SECURITY APPS
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'jv' && styles.tabBtnActive]}
          onPress={() => setActiveTab('jv')}
          activeOpacity={0.8}>
          <Text style={[styles.tabBtnText, activeTab === 'jv' && styles.tabBtnTextActive]}>
            GEO JV ADVERTS
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}
        showsVerticalScrollIndicator={false}>

        {activeTab === 'cyber' ? (
          <>
            {/* Revenue notice */}
            <View style={styles.notice}>
              <Icon name="cash-multiple" size={14} color="#A78BFA" style={{marginTop: 1}} />
              <Text style={styles.noticeText}>
                Bravo earns commission on every subscription activated through in-app links.
              </Text>
            </View>

            {CYBER_APPS.map(app => {
              const offered = offerStates[app.id];
              return (
                <View key={app.id} style={styles.appCard}>
                  <View style={styles.appCardTop}>
                    <View style={[styles.appIcon, {backgroundColor: app.iconBg, borderColor: app.iconBorder}]}>
                      <Icon name={app.icon} size={22} color={app.iconColor} />
                    </View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <View style={styles.appNameRow}>
                        <Text style={styles.appName}>{app.name}</Text>
                        <View style={[styles.badge, {backgroundColor: app.badgeBg, borderColor: app.badgeBorder}]}>
                          <Text style={[styles.badgeText, {color: app.badgeColor}]}>{app.badge}</Text>
                        </View>
                      </View>
                      <Text style={styles.appSub}>{app.sub}</Text>
                      <View style={styles.appPriceRow}>
                        <Text style={styles.appPrice}>{app.price}</Text>
                        <View style={styles.starsRow}>
                          {Array.from({length: 5}, (_, i) => (
                            <Icon key={i} name={i < app.stars ? 'star' : 'star-outline'} size={12} color={i < app.stars ? '#FBBF24' : '#475569'} />
                          ))}
                          <Text style={styles.ratingText}>{app.rating}</Text>
                        </View>
                      </View>
                    </View>
                  </View>
                  <TouchableOpacity
                    style={[styles.offerBtn, offered && styles.offerBtnSuccess]}
                    onPress={() => handleOffer(app.id)}
                    activeOpacity={0.85}>
                    <Text style={[styles.offerBtnText, offered && styles.offerBtnTextSuccess]}>
                      {offered ? '✓ OFFER LINK COPIED' : 'GET OFFER · EARN COMMISSION $'}
                    </Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </>
        ) : (
          <>
            {/* Revenue notice */}
            <View style={styles.notice}>
              <Icon name="earth" size={14} color="#A78BFA" style={{marginTop: 1}} />
              <Text style={styles.noticeText}>
                Geographic JV partners share ad revenue based on verified user impressions per region.
              </Text>
            </View>

            {JV_ADVERTS.map(jv => {
              const enquired = offerStates[jv.id];
              return (
                <View key={jv.id} style={styles.jvCard}>
                  <View style={styles.jvTop}>
                    <View style={styles.flagBox}>
                      <Text style={styles.flagText}>{jv.flag}</Text>
                    </View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <View style={styles.jvTagRow}>
                        <View style={[styles.badge, {backgroundColor: jv.catBg, borderColor: 'transparent'}]}>
                          <Text style={[styles.badgeText, {color: jv.catColor}]}>{jv.category}</Text>
                        </View>
                        <View style={styles.regionBadge}>
                          <Text style={styles.regionText}>{jv.region}</Text>
                        </View>
                      </View>
                      <Text style={styles.jvTitle}>{jv.title}</Text>
                      <Text style={styles.jvSub}>{jv.sub}</Text>
                    </View>
                  </View>
                  <View style={styles.jvActions}>
                    <TouchableOpacity
                      style={[styles.enquireBtn, enquired && styles.offerBtnSuccess, {flex: 1}]}
                      onPress={() => handleOffer(jv.id)}
                      activeOpacity={0.85}>
                      <Text style={[styles.offerBtnText, enquired && styles.offerBtnTextSuccess]}>
                        {enquired ? '✓ ENQUIRY SENT' : 'ENQUIRE · JV PARTNER $'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.saveBtn}>
                      <Text style={styles.saveBtnText}>SAVE</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  backBtn: {width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18},
  headerTitle: {flex: 1, fontSize: 14, fontWeight: '700', color: '#E2E8F0', textAlign: 'center', marginLeft: -36},
  partnerBadge: {backgroundColor: 'rgba(124,58,237,0.1)', borderWidth: 1, borderColor: 'rgba(124,58,237,0.3)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99},
  partnerText: {fontSize: 9, fontWeight: '800', color: '#C4B5FD'},

  tabSwitcher: {flexDirection: 'row', gap: 6, marginHorizontal: 16, marginTop: 12, marginBottom: 4, padding: 4, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 12},
  tabBtn: {flex: 1, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 8, alignItems: 'center'},
  tabBtnActive: {backgroundColor: 'rgba(37,99,235,0.15)'},
  tabBtnText: {fontSize: 10, fontWeight: '800', letterSpacing: 1, color: '#475569'},
  tabBtnTextActive: {color: '#60A5FA'},

  content: {paddingHorizontal: 16, paddingTop: 12, gap: 12},

  notice: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: 'rgba(124,58,237,0.06)', borderWidth: 1, borderColor: 'rgba(124,58,237,0.18)', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12},
  noticeText: {flex: 1, fontSize: 11, color: '#94A3B8', lineHeight: 17},

  appCard: {backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 14, padding: 14, gap: 12},
  appCardTop: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
  appIcon: {width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  appNameRow: {flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2},
  appName: {fontSize: 13, fontWeight: '800', color: '#E2E8F0'},
  appSub: {fontSize: 11, color: '#64748B'},
  appPriceRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4},
  appPrice: {fontSize: 12, fontWeight: '800', color: '#E2E8F0'},
  starsRow: {flexDirection: 'row', alignItems: 'center', gap: 1, marginLeft: 4},
  ratingText: {fontSize: 10, color: '#64748B', marginLeft: 2},
  badge: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1},
  badgeText: {fontSize: 8, fontWeight: '800'},
  offerBtn: {backgroundColor: 'rgba(37,99,235,0.15)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.35)', borderRadius: 12, paddingVertical: 10, alignItems: 'center'},
  offerBtnSuccess: {backgroundColor: 'rgba(34,197,94,0.12)', borderColor: 'rgba(34,197,94,0.3)'},
  offerBtnText: {fontSize: 11, fontWeight: '800', color: '#60A5FA', letterSpacing: 1},
  offerBtnTextSuccess: {color: '#4ADE80'},

  jvCard: {backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 14, padding: 14, gap: 10},
  jvTop: {flexDirection: 'row', alignItems: 'flex-start', gap: 8},
  flagBox: {width: 28, height: 28, borderRadius: 8, backgroundColor: '#1E2D45', alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  flagText: {fontSize: 13},
  jvTagRow: {flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap'},
  regionBadge: {backgroundColor: '#1E2D45', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4},
  regionText: {fontSize: 9, fontWeight: '800', color: '#64748B'},
  jvTitle: {fontSize: 13, fontWeight: '800', color: '#E2E8F0', marginTop: 4},
  jvSub: {fontSize: 11, color: '#64748B', marginTop: 2},
  jvActions: {flexDirection: 'row', gap: 8},
  enquireBtn: {backgroundColor: 'rgba(37,99,235,0.15)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.35)', borderRadius: 12, paddingVertical: 10, alignItems: 'center'},
  saveBtn: {backgroundColor: '#1E2D45', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center'},
  saveBtnText: {fontSize: 11, fontWeight: '700', color: '#94A3B8'},
}));
