/**
 * B-91 M0 — post-auth product gate.
 *
 * Shown to a signed-in CLIENT account with no persisted active product
 * (fresh installs after the product split, and every pre-split account on
 * first launch). Picking a card sets `activeProduct`, and the client shell
 * mounts that product directly — there is deliberately no skip: the spec
 * has no combined home to fall back to.
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar, ScrollView,
  type ImageSourcePropType} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useProductStore, type BravoProduct} from '@store/productStore';
import {scaleTextStyles} from '@utils/scaling';

const T = {
  bg: '#07090D',
  text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)',
  accent: '#5B8DEF',
  hair: 'rgba(255,255,255,0.08)',
};

const PRODUCTS: Array<{
  key: BravoProduct;
  icon: React.ComponentProps<typeof Icon>['name'];
  title: string;
  desc: string;
  badge?: string;
  img: ImageSourcePropType;
}> = [
  {key: 'messenger', icon: 'message-lock-outline', title: 'Messenger', desc: 'Secure encrypted communications, team chats, calls & news.', img: Imagery.messengerHero},
  {key: 'secure', icon: 'shield-check-outline', title: 'Secure Services', desc: 'On-demand security, transfers & executive protection.', img: Imagery.heroBookProtection},
  {key: 'vbg', icon: 'shield-account-outline', title: 'Virtual Bodyguard', desc: 'AI-powered personal safety monitoring & risk intelligence.', badge: 'AI', img: Imagery.vbgHero},
];

export default function ProductGateScreen() {
  const insets = useSafeAreaInsets();
  const setActiveProduct = useProductStore(s => s.setActiveProduct);

  // B-95 — the gate is also re-openable from INSIDE a product (drawer
  // "Choose dashboard" / hardware back at a product root). Leaving Secure
  // Services with an unfinished booking form still warns first, mirroring
  // SwitchDashboardSection (spec p.26). Fresh logins have no draft → no-op.
  const pick = (p: BravoProduct) => {
    const {activeProduct} = useProductStore.getState();
    if (activeProduct === 'secure' && p !== 'secure') {
      const {isBookingDraftDirty} =
        require('@store/bookingStore') as typeof import('@store/bookingStore');
      if (isBookingDraftDirty()) {
        const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
        Alert.alert(
          'Booking in progress',
          'You have an unfinished booking. Leave Secure Services and discard it?',
          [
            {text: 'Stay', style: 'cancel'},
            {text: 'Leave', style: 'destructive', onPress: () => setActiveProduct(p)},
          ],
        );
        return;
      }
    }
    setActiveProduct(p);
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top + 24}]}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />
      <ScrollView contentContainerStyle={{paddingBottom: insets.bottom + 32}} showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>Choose your dashboard</Text>
        <Text style={styles.title}>Where would you{'\n'}like to start?</Text>
        <Text style={styles.subtitle}>
          You can switch products any time from Profile → Switch Dashboard.
        </Text>

        <View style={styles.cards}>
          {PRODUCTS.map(p => (
            <TouchableOpacity
              key={p.key}
              style={styles.card}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={`Open ${p.title}`}
              onPress={() => pick(p.key)}>
              {/* `band`, not `hero`: nothing is written over these photos —
                  the title and description live in `cardBody` below — so the
                  hero scrim was darkening the artwork to protect copy that is
                  not there (founder, 2026-08-31). */}
              <View style={styles.cardBand}>
                <ImageryBackdrop source={p.img} variant="band" />
              </View>
              <View style={styles.cardBody}>
                <View style={styles.cardIcon}>
                  <Icon name={p.icon} size={24} color={T.accent} />
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <View style={styles.cardTitleRow}>
                    <Text style={styles.cardTitle}>{p.title}</Text>
                    {p.badge ? (
                      <View style={styles.badge}><Text style={styles.badgeText}>{p.badge}</Text></View>
                    ) : null}
                  </View>
                  <Text style={styles.cardDesc}>{p.desc}</Text>
                </View>
                <Icon name="arrow-right" size={20} color={T.textMute} />
              </View>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: T.bg, paddingHorizontal: 24},
  eyebrow: {fontFamily: 'monospace', color: T.accent, fontSize: 12, fontWeight: '700', letterSpacing: 3, textTransform: 'uppercase', marginBottom: 12},
  title: {color: T.text, fontSize: 32, fontWeight: '700', letterSpacing: -1, lineHeight: 38},
  subtitle: {color: T.textDim, fontSize: 14, marginTop: 10, lineHeight: 20},
  cards: {marginTop: 32, gap: 14},
  card: {
    borderRadius: 18, borderWidth: 1, borderColor: T.hair,
    backgroundColor: 'rgba(255,255,255,0.03)', overflow: 'hidden',
  },
  // The photo band. It holds ONLY the backdrop — every piece of copy is in the
  // sibling `cardBody` — which is why it uses the `band` variant: full image
  // brightness, with the gradient confined to the bottom third purely so the
  // band dissolves into cardBody instead of ending on a hard edge. If a label
  // is ever moved INTO this view, the variant has to change back.
  cardBand: {height: 104, overflow: 'hidden'},
  cardBody: {flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18},
  cardIcon: {
    width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
  },
  cardTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  cardTitle: {flexShrink: 1, minWidth: 0, color: T.text, fontSize: 16, fontWeight: '700'},
  badge: {flexShrink: 0, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(124,58,237,0.18)', borderWidth: 1, borderColor: 'rgba(124,58,237,0.4)'},
  badgeText: {color: '#C4B5FD', fontSize: 9, fontWeight: '800', letterSpacing: 1},
  cardDesc: {color: T.textDim, fontSize: 12.5, marginTop: 3, lineHeight: 17},
}));
