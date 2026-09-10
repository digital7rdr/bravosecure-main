import React from 'react';
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
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

const STATS = [
  {value: '0', label: 'JOBS', color: '#93C5FD'},
  {value: '—', label: 'RATING', color: '#93C5FD'},
  {value: 'Live', label: 'STATUS', color: '#4ADE80'},
];

export default function AgentVerifiedScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        {/* Icon + rings */}
        <View style={styles.iconSection}>
          <View style={styles.ringsWrap}>
            <View style={[styles.ring, styles.ring1]} />
            <View style={[styles.ring, styles.ring2]} />
            <View style={[styles.ring, styles.ring3]} />
            <View style={styles.checkCircle}>
              <Icon name="check" size={44} color="#FFF" />
            </View>
          </View>

          <Text style={styles.title}>You're Live on Bravo Secure!</Text>
          <Text style={styles.sub}>Your account is verified and active. You can now receive job assignments.</Text>

          {/* Activated badge */}
          <View style={styles.activatedBadge}>
            <Icon name="check-decagram" size={16} color="#D4AF37" />
            <Text style={styles.activatedText}>ACTIVATED: 16 MARCH 2026</Text>
          </View>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          {STATS.map((stat, idx) => (
            <View key={idx} style={styles.statCard}>
              <Text style={[styles.statValue, {color: stat.color}]}>{stat.value}</Text>
              <Text style={styles.statLabel}>{stat.label}</Text>
            </View>
          ))}
        </View>

        {/* CTAs */}
        <View style={styles.ctas}>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => navigation.navigate('JobMarketplace')}
            activeOpacity={0.85}>
            <Icon name="trending-up" size={20} color="#FFF" />
            <Text style={styles.primaryBtnText}>Go to Job Marketplace</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryBtn} activeOpacity={0.8}>
            <Text style={styles.secondaryBtnText}>View My Profile</Text>
          </TouchableOpacity>
        </View>

        {/* Security badge */}
        <View style={styles.securityBadge}>
          <Icon name="shield-account" size={20} color="#64748B" />
          <View style={styles.securityInfo}>
            <Text style={styles.securityTitle}>Identity Verified</Text>
            <Text style={styles.securitySub}>BANK-GRADE ENCRYPTION ACTIVE</Text>
          </View>
          <View style={styles.activePill}>
            <View style={styles.activeDot} />
            <Text style={styles.activeText}>ACTIVE</Text>
          </View>
        </View>

      </ScrollView>

      {/* Bottom Nav */}
      <View style={[styles.bottomNav, {paddingBottom: insets.bottom}]}>
        <TouchableOpacity style={styles.navItem} activeOpacity={0.7}>
          <Icon name="home" size={22} color="#64748B" />
          <Text style={styles.navLabel}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} onPress={() => navigation.navigate('JobMarketplace')} activeOpacity={0.7}>
          <Icon name="briefcase" size={22} color={Colors.primary} />
          <Text style={[styles.navLabel, {color: Colors.primary}]}>Jobs</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} activeOpacity={0.7}>
          <Icon name="account" size={22} color="#64748B" />
          <Text style={styles.navLabel}>Profile</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navItem} activeOpacity={0.7}>
          <Icon name="cog" size={22} color="#64748B" />
          <Text style={styles.navLabel}>Settings</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  content: {paddingHorizontal: 20, paddingTop: 60, alignItems: 'center', gap: 24},

  iconSection: {alignItems: 'center', gap: 12},
  ringsWrap: {width: 128, height: 128, alignItems: 'center', justifyContent: 'center', marginBottom: 8},
  ring: {position: 'absolute', borderRadius: 99, borderWidth: 2},
  ring1: {width: 128, height: 128, borderColor: 'rgba(37,99,235,0.3)'},
  ring2: {width: 128, height: 128, borderColor: 'rgba(37,99,235,0.2)'},
  ring3: {width: 128, height: 128, borderColor: 'rgba(37,99,235,0.1)'},
  checkCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {fontSize: 24, fontWeight: '800', color: '#F1F5F9', textAlign: 'center', lineHeight: 30},
  sub: {fontSize: 14, color: '#94A3B8', textAlign: 'center', lineHeight: 21, maxWidth: 280},
  activatedBadge: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(212,175,55,0.1)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.3)', borderRadius: 99, paddingHorizontal: 16, paddingVertical: 8},
  activatedText: {fontSize: 12, fontWeight: '700', color: '#D4AF37', letterSpacing: 1.5, textTransform: 'uppercase'},

  statsRow: {flexDirection: 'row', gap: 12, width: '100%'},
  statCard: {flex: 1, backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 12, alignItems: 'center'},
  statValue: {fontSize: 18, fontWeight: '800'},
  statLabel: {fontSize: 9, fontWeight: '700', color: '#64748B', letterSpacing: 1.5, marginTop: 2, textTransform: 'uppercase'},

  ctas: {width: '100%', gap: 12},
  primaryBtn: {backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  primaryBtnText: {color: '#FFF', fontSize: 14, fontWeight: '700', letterSpacing: 0.4},
  secondaryBtn: {backgroundColor: 'rgba(37,99,235,0.06)', borderRadius: 12, paddingVertical: 10, paddingHorizontal: 20, borderWidth: 1, borderColor: 'rgba(37,99,235,0.2)', alignItems: 'center'},
  secondaryBtnText: {color: '#93C5FD', fontSize: 14, fontWeight: '600'},

  securityBadge: {width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 14},
  securityInfo: {flex: 1},
  securityTitle: {fontSize: 10, fontWeight: '700', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 1.5},
  securitySub: {fontSize: 10, color: '#334155', textTransform: 'uppercase', letterSpacing: 0.5},
  activePill: {flexDirection: 'row', alignItems: 'center', gap: 4},
  activeDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ADE80'},
  activeText: {fontSize: 10, fontWeight: '700', color: '#4ADE80'},

  bottomNav: {backgroundColor: Colors.background, borderTopWidth: 1, borderTopColor: '#1E2D45', flexDirection: 'row', paddingTop: 8, paddingHorizontal: 24},
  navItem: {flex: 1, alignItems: 'center', gap: 4},
  navLabel: {fontSize: 10, fontWeight: '700', color: '#64748B'},
}));
