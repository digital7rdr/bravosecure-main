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
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';
import {isProUser} from '@utils/tier';

type PathKey = 'lite' | 'pro' | 'vb';

interface PathConfig {
  key: PathKey;
  label: string;
  sub: string;
  icon: React.ComponentProps<typeof Icon>['name'];
  color: string;
  colorLight: string;
  badgeBg: string;
  badgeColor: string;
  ctaLabel: string;
  tierLabel: string;
  tierBg: string;
}

const PATHS: PathConfig[] = [
  {
    key: 'lite',
    label: 'Bravo Secure Lite',
    sub: 'Secure messaging · Chats · News',
    icon: 'chat',
    color: '#1E88FF',
    colorLight: 'rgba(30,136,255,0.16)',
    badgeBg: 'rgba(30,136,255,0.18)',
    badgeColor: '#3BA6FF',
    ctaLabel: 'Open Bravo Secure Lite',
    tierLabel: 'LITE',
    tierBg: '#1E88FF',
  },
  {
    key: 'pro',
    label: 'Bravo Secure Pro',
    sub: 'Full security suite · Ops · Booking · Messenger',
    icon: 'shield',
    color: '#1E88FF',
    colorLight: 'rgba(30,136,255,0.16)',
    badgeBg: 'rgba(30,136,255,0.18)',
    badgeColor: '#B8C7E0',
    ctaLabel: 'Subscribe to Bravo Secure Pro',
    tierLabel: 'PRO',
    tierBg: '#166ED1',
  },
  {
    key: 'vb',
    label: 'Virtual Bodyguard',
    sub: 'AI safety monitoring · SRA · OSINT feed',
    icon: 'robot',
    color: '#00A3FF',
    colorLight: 'rgba(0,163,255,0.14)',
    badgeBg: 'rgba(0,163,255,0.16)',
    badgeColor: '#B8C7E0',
    ctaLabel: 'Open Virtual Bodyguard',
    tierLabel: 'AI',
    tierBg: '#00A3FF',
  },
];

export default function HomeSelectionScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<PathKey>('lite');

  const user = useAuthStore(s => s.user);
  const pro = isProUser(user);

  // The Pro path's badge reflects the user's live tier: a locked "LITE"
  // chip until they subscribe, then a "PRO" chip once active. Lite + VBG
  // keep their static labels.
  const badgeFor = (p: PathConfig): {label: string; bg: string} => {
    if (p.key !== 'pro') {return {label: p.tierLabel, bg: p.tierBg};}
    return pro
      ? {label: 'PRO', bg: '#166ED1'}
      : {label: 'LITE', bg: '#475569'};
  };

  const primary = PATHS.find(p => p.key === selected)!;
  const alts = PATHS.filter(p => p.key !== selected);
  const primaryBadge = badgeFor(primary);

  const proceed = () => {
    navigation.navigate('Main' as never);
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 100}]}
        showsVerticalScrollIndicator={false}>

        {/* Header */}
        <Text style={styles.eyebrow}>Default Home Screen</Text>
        <Text style={styles.heading}>Choose your default</Text>
        <Text style={styles.sub}>
          Choose which screen you'd like to see when you open Bravo.{'\n'}You can change this anytime in Settings.
        </Text>

        {/* Primary card */}
        <View style={[
          styles.primaryCard,
          {borderColor: primary.color + '50', shadowColor: primary.color},
        ]}>
          <ImageryBackdrop source={Imagery.heroBookProtection} variant="hero" radius={22} />
          {/* Glow blob */}
          <View style={[styles.glowBlob, {backgroundColor: primary.color + '38'}]} />

          {/* Icon */}
          <View style={[styles.iconBox, {backgroundColor: primary.colorLight, borderColor: primary.color + '60'}]}>
            <Icon name={primary.icon} size={36} color={primary.color} />
          </View>

          {/* Title + tier */}
          <View style={styles.primaryMeta}>
            <View style={styles.primaryTitleRow}>
              <Text style={styles.primaryLabel}>{primary.label.toUpperCase()}</Text>
              <View style={[styles.tierBadge, {backgroundColor: primaryBadge.bg}]}>
                <Text style={styles.tierBadgeText}>{primaryBadge.label}</Text>
              </View>
            </View>
            <Text style={styles.primarySub}>{primary.sub}</Text>
          </View>

          {/* Selected badge */}
          <View style={[styles.selBadge, {backgroundColor: primary.badgeBg}]}>
            <Icon name="check-circle" size={14} color={primary.badgeColor} />
            <Text style={[styles.selBadgeText, {color: primary.badgeColor}]}>Selected</Text>
          </View>
        </View>

        {/* Alt paths */}
        <Text style={styles.altLabel}>Or switch to</Text>
        <View style={styles.altList}>
          {alts.map(p => (
            <TouchableOpacity
              key={p.key}
              style={styles.altCard}
              onPress={() => setSelected(p.key)}
              activeOpacity={0.8}>
              <View style={[styles.altIcon, {backgroundColor: p.colorLight}]}>
                <Icon name={p.icon} size={20} color={p.color} />
              </View>
              <View style={styles.altMeta}>
                <View style={styles.altNameRow}>
                  <Text style={styles.altName} numberOfLines={1}>{p.label}</Text>
                  <View style={[styles.altBadge, {backgroundColor: badgeFor(p).bg}]}>
                    <Text style={styles.altBadgeText}>{badgeFor(p).label}</Text>
                  </View>
                </View>
                <Text style={styles.altSub} numberOfLines={1}>{p.sub}</Text>
              </View>
              <Icon name="chevron-right" size={18} color="#334155" />
            </TouchableOpacity>
          ))}
        </View>

      </ScrollView>

      {/* CTA */}
      <View style={[styles.footer, {paddingBottom: insets.bottom + 20}]}>
        <TouchableOpacity
          style={[styles.ctaBtn, {backgroundColor: primary.color}]}
          onPress={proceed}
          activeOpacity={0.85}>
          <Text style={styles.ctaBtnText}>{primary.ctaLabel}</Text>
          <Icon name="arrow-right" size={19} color="#FFF" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  scroll: {paddingHorizontal: 20, paddingTop: 48},

  eyebrow: {fontSize: 10, fontWeight: '700', letterSpacing: 3, textTransform: 'uppercase', color: '#B8C7E0', marginBottom: 8},
  heading: {fontSize: 24, fontWeight: '800', color: '#FFFFFF', marginBottom: 6},
  sub: {fontSize: 12, color: '#B8C7E0', lineHeight: 18, marginBottom: 24},

  primaryCard: {
    backgroundColor: '#1B3A66',
    borderRadius: 22,
    borderWidth: 1.5,
    padding: 24,
    alignItems: 'center',
    gap: 16,
    marginBottom: 20,
    overflow: 'hidden',
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 5,
  },
  glowBlob: {
    position: 'absolute',
    width: 240,
    height: 240,
    borderRadius: 120,
    top: '50%',
    left: '50%',
    marginTop: -120,
    marginLeft: -120,
    opacity: 0.22,
  },
  iconBox: {
    width: 72,
    height: 72,
    borderRadius: 20,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  primaryMeta: {alignItems: 'center', gap: 6, zIndex: 1},
  primaryTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  primaryLabel: {fontSize: 15, fontWeight: '800', color: '#FFFFFF', letterSpacing: 2},
  tierBadge: {paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5},
  tierBadgeText: {fontSize: 8, fontWeight: '800', color: '#FFF', letterSpacing: 1.2},
  primarySub: {fontSize: 12, color: '#B8C7E0', textAlign: 'center', lineHeight: 18},
  selBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, zIndex: 1},
  selBadgeText: {fontSize: 12, fontWeight: '700'},

  altLabel: {fontSize: 10, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', color: '#7E8AA6', marginBottom: 8},
  altList: {gap: 8},
  altCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1B3A66',
    borderWidth: 1,
    borderColor: '#1C3B66',
    borderRadius: 14,
    padding: 13,
  },
  altIcon: {width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  altMeta: {flex: 1, minWidth: 0},
  altNameRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  altName: {flexShrink: 1, minWidth: 0, fontSize: 13, fontWeight: '700', color: '#FFFFFF'},
  altBadge: {flexShrink: 0, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4},
  altBadgeText: {fontSize: 7.5, fontWeight: '800', color: '#FFF', letterSpacing: 1},
  altSub: {fontSize: 11, color: '#7E8AA6', marginTop: 1},

  footer: {paddingHorizontal: 20, paddingTop: 12, backgroundColor: Colors.background},
  ctaBtn: {
    borderRadius: 18,
    paddingVertical: 17,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  ctaBtnText: {fontSize: 15, fontWeight: '700', color: '#FFF'},
}));
