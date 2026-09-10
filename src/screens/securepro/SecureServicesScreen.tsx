/**
 * Bravo Secure — service plan chooser.
 *
 * Entry: Booking Services home → "Bravo Secure Plans". Two plans as
 * edge-lit cards (obsidian/cobalt, mirrors ServiceTypeScreen):
 * Bravo Secure Pro (live — request-and-approval custom plan) and
 * Bravo Secure Lux (COMING SOON — a tappable TEASER card that opens the
 * SecureLux future-plan showcase; it books nothing yet).
 * On-demand Lite booking is no longer a plan card here — it is reached from
 * the Book-Now home (ZoneMap); this screen is the retainer-plan chooser.
 * Cards navigate directly; there is no select+continue step here.
 */
import React, {useCallback} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation, useFocusEffect, useNavigationState} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useSecureProStore} from '@store/secureProStore';
import {usePlanCatalogStore, planCopy} from '@store/planCatalogStore';
import {PRO_STATUS_META} from './proStatus';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureServices'>;

const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

type IconName = React.ComponentProps<typeof Icon>['name'];

interface PlanDef {
  key: 'lite' | 'pro' | 'lux';
  title: string;
  desc: string;
  icon: IconName;
  chip?: string;
  chipSub?: string;
  comingSoon?: boolean;
  /** A coming-soon plan that still opens a teaser page (not a dead card). */
  teaser?: boolean;
}

const PLANS: PlanDef[] = [
  {
    key: 'pro',
    title: 'Bravo Secure Pro',
    desc: 'Custom protection plan for periods beyond 24 hours — dedicated team, journey monitoring and operational support.',
    icon: 'shield-star',
    chip: 'CUSTOM',
    chipSub: 'PLAN ON REQUEST',
  },
  {
    // Premium tier — coming soon, but the card OPENS the SecureLux teaser
    // (future-plan showcase) instead of being dead. The one in-app "Lux".
    key: 'lux',
    title: 'Bravo Secure Lux',
    desc: 'Premium white-glove service — private aircraft, armored fleet, yachts and elite protection logistics, arranged worldwide.',
    icon: 'shield-crown',
    comingSoon: true,
    teaser: true,
  },
];

/** Catalog keys for the two plan cards (ops-editable copy overlay). */
const PLAN_CATALOG_KEY: Record<PlanDef['key'], string> = { lite: 'secure_lite', pro: 'secure_pro', lux: 'secure_lux'};

function PlanCard({plan, onPress, statusPill, isCurrent}: {
  plan: PlanDef; onPress: () => void;
  statusPill?: {label: string; color: string} | null;
  isCurrent?: boolean;
}) {
  // A teaser card keeps its COMING SOON badge but is fully tappable — it
  // sells the future tier instead of sitting dead under a lock.
  const catalogByKey = usePlanCatalogStore(st => st.byKey);
  const copy = planCopy(catalogByKey, PLAN_CATALOG_KEY[plan.key] ?? plan.key, plan.title, plan.desc);
  const locked = !!plan.comingSoon && !plan.teaser;
  const dimmed = !!plan.comingSoon && !plan.teaser;
  return (
    <TouchableOpacity
      activeOpacity={locked ? 1 : 0.85}
      onPress={locked ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={plan.teaser ? `${copy.name} — coming soon, view details` : copy.name}
      accessibilityState={{disabled: locked}}
      style={[s.card, dimmed ? s.cardLocked : s.cardLive]}>
      <View style={s.cardTopLight} />

      <View style={[s.icTile, dimmed ? s.icTileIdle : s.icTileLive]}>
        <Icon name={plan.icon} size={24} color={dimmed ? D.textMute : D.accentSoft} />
      </View>

      <View style={s.body}>
        <View style={s.titleRow}>
          <Text style={[s.title, dimmed && s.titleDim]}>{copy.name}</Text>
          {isCurrent && (
            <View style={s.currentPill}>
              <Text style={s.currentPillText}>CURRENT</Text>
            </View>
          )}
          {plan.comingSoon && (
            <View style={s.soonPill}>
              <Text style={s.soonPillText}>COMING SOON</Text>
            </View>
          )}
          {statusPill && (
            <View style={[s.statusPill, {backgroundColor: statusPill.color + '14', borderColor: statusPill.color + '4D'}]}>
              <Text style={[s.statusPillText, {color: statusPill.color}]}>{statusPill.label.toUpperCase()}</Text>
            </View>
          )}
        </View>
        <Text style={s.desc}>{copy.desc}</Text>
        {plan.chip && !locked && (
          <View style={s.priceChip}>
            <Text style={s.priceFrom}>{plan.chip}</Text>
            <Text style={s.priceValue}>{plan.chipSub}</Text>
          </View>
        )}
      </View>

      {locked ? (
        <Icon name="lock-outline" size={20} color={D.textFaint} />
      ) : (
        <Icon name="chevron-right" size={22} color={D.textMute} />
      )}
    </TouchableOpacity>
  );
}

export default function SecureServicesScreen() {
  const loadPlanCatalog = usePlanCatalogStore(st => st.load);
  useFocusEffect(useCallback(() => { void loadPlanCatalog(); }, [loadPlanCatalog]));

  const insets = useSafeAreaInsets();
  const {contentBottom} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const application = useSecureProStore(st => st.application);
  const loadApplication = useSecureProStore(st => st.loadApplication);

  // Keep the Pro card state-aware — re-entering this screen after a submit
  // (or a status change from the Bravo Control System) routes correctly.
  useFocusEffect(useCallback(() => { void loadApplication(); }, [loadApplication]));

  // Is the Secure home ACTUALLY the thing back lands on? Asked of the live
  // stack rather than assumed, because it is not always true and a hint that
  // lies is worse than no hint:
  //
  //   - entered from Profile while the active product is `messenger`,
  //     BookingNavigator has never mounted and `ProfileScreen`'s `handleRow`
  //     omits `initial: false`, so this screen becomes the stack's ONLY route
  //     and back bubbles out to a tab;
  //   - inside the `vbg` product the stack is rooted at VBGHome, so back lands
  //     there — still a Secure*Tab*, but not the Secure home.
  //
  // Both are cross-product excursions rather than the flow this line is written
  // for, and in both the line simply does not render.
  const backsToSecureHome = useNavigationState(st => {
    const routes = st?.routes ?? [];
    return routes.length > 1 && routes[0]?.name === 'BookingHome';
  });

  const openPlan = (key: PlanDef['key']) => {
    // Executive Protection lives INSIDE Lite (ZoneMap → Select Service →
    // Executive Protection wizard). 'lux' opens the coming-soon teaser.
    if (key === 'lite') {
      navigation.navigate('ZoneMap');
    } else if (key === 'lux') {
      navigation.navigate('SecureLux');
    } else if (key === 'pro') {
      // An in-flight or active application owns the Pro entry: re-entry goes
      // straight to its state (never back to the intro/form). Only a closed
      // slot — REJECTED/CANCELLED (or no application) — opens the intro to
      // (re-)apply.
      if (application?.status === 'ACTIVE') {
        navigation.navigate('ProDashboard');
      } else if (application && application.status !== 'REJECTED' && application.status !== 'CANCELLED') {
        navigation.navigate('SecureProStatus');
      } else {
        navigation.navigate('SecureProIntro');
      }
    }
  };

  const proStatusMeta = application ? PRO_STATUS_META[application.status] : null;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View pointerEvents="none" style={s.ambient} />

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
          <Text style={s.headerTitle}>Secure Plans</Text>
          <FitLine style={s.headerSub} text={'BRAVO SECURE SERVICE · CHOOSE YOUR PLAN'} />
        </View>
      </View>

      {/* Founder 2026-08-08 — say where back goes.
          Switching to Secure Services now LANDS here rather than on the booking
          hero (B-390/B-393), so this screen is the first thing the user sees and
          the chevron/back-swipe is no longer obviously "up one level".

          It names the Secure home rather than "where you came from", because
          those are not the same thing and the vaguer wording was FALSE more
          often. Every entry inside the secure product puts `BookingHome`
          directly beneath this screen — the product switch rebuilds the stack
          as [BookingHome, SecureServices] (MainNavigator `initialParams`), the
          drawer's same-product tap and BookingHome's own row both push onto it,
          and a mid-wizard tap pops back down to it. So back lands on the Secure
          home in every one of them, never on a dead end or an app exit.

          It is CONDITIONAL (`backsToSecureHome`) rather than always-on, because
          two cross-product excursions land back somewhere else — see the hook
          for both. Rendering it unconditionally would state something false on
          a reachable path, and this sentence is the accessibility label too, so
          a screen-reader user would get the same wrong promise. */}
      {backsToSecureHome && (
        <View
          style={s.backHint}
          accessible
          accessibilityRole="text"
          accessibilityLabel="Back returns to your Secure home.">
          {/* Decorative — the sentence already carries the meaning, and an
              un-hidden icon makes the reader announce its Private-Use glyph. */}
          <Icon
            name="arrow-u-left-top"
            size={14}
            color={D.textDim}
            importantForAccessibility="no"
            accessibilityElementsHidden
          />
          <Text style={s.backHintText}>Back returns to your Secure home.</Text>
        </View>
      )}

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(24), gap: 13}}
        showsVerticalScrollIndicator={false}>
        {PLANS.map(plan => (
          <PlanCard
            key={plan.key}
            plan={plan}
            onPress={() => openPlan(plan.key)}
            statusPill={plan.key === 'pro' ? proStatusMeta : null}
            // Dynamic: an ACTIVE Secure Pro plan owns CURRENT. Lite is no longer
            // a card here (it lives on the Book-Now home), so no card is CURRENT
            // for a Lite client.
            isCurrent={application?.status === 'ACTIVE' && plan.key === 'pro'}
          />
        ))}

        <View style={s.noteCard}>
          <Icon name="information-outline" size={16} color={D.textMute} />
          <Text style={s.noteText}>
            You can keep using Bravo Secure Lite while a Pro application is being reviewed —
            nothing is locked.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, overflow: 'hidden'},

  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 280, borderRadius: 230,
    backgroundColor: 'rgba(91,141,239,0.07)',
  },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
  },
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  headerSub: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  // Sits between the header and the cards, on the SCROLL gutter (20) rather
  // than under the header text, so it reads as a page-level note and not as a
  // third line of the title.
  //
  // Sentence-case SANS on purpose. `headerSub` owns the mono micro-label role
  // here, and a mono line directly under it would compete with it for the same
  // rank. It is also why this is `textDim` (6.6:1 on obsidian) and not
  // `textMute`/`textFaint` — those are 2.9:1 and 1.8:1, so real copy set in
  // them fails WCAG AA outright (DESIGN_REVIEW_LOOP G2).
  //
  // `alignItems: center`, not `flex-start`: the icon comes from
  // react-native-vector-icons, which hard-sets `allowFontScaling = false`, so
  // its box stays 14 while the text grows. Top-aligning a fixed box to a
  // growing one drifts the arrow above the cap height. Measured, the line stays
  // SINGLE from 320dp to tablet and first wraps around fontScale 1.48, so
  // centring is right for effectively every real case; `flexShrink: 1` still
  // wraps rather than clips past that.
  backHint: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, paddingBottom: 14,
  },
  backHintText: {
    flexShrink: 1,
    fontFamily: D.fSans, fontSize: 11.5, lineHeight: 16, color: D.textDim,
  },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: 15,
    padding: 16, borderRadius: 22, overflow: 'hidden',
  },
  cardLive: {backgroundColor: 'rgba(16,26,46,0.6)', borderWidth: 1, borderColor: D.hair2},
  cardLocked: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair, opacity: 0.55},
  cardTopLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(120,160,255,0.25)'},

  icTile: {
    width: 52, height: 52, borderRadius: 15, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  icTileIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  icTileLive: {backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)'},

  body: {flex: 1, minWidth: 0},
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: 9, flexWrap: 'wrap'},
  title: {fontFamily: D.fBold, fontSize: 17, letterSpacing: -0.3, color: D.text},
  titleDim: {color: D.textDim},
  desc: {fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, letterSpacing: -0.05, color: D.textDim, marginTop: 6},

  currentPill: {
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6,
    backgroundColor: 'rgba(91,141,239,0.13)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
    overflow: 'hidden',
  },
  currentPillText: {fontFamily: D.fBold, fontSize: 8.5, letterSpacing: 1.2, color: D.accentSoft},

  soonPill: {
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6,
    backgroundColor: 'rgba(245,181,68,0.10)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.34)',
    overflow: 'hidden',
  },
  soonPillText: {fontFamily: D.fBold, fontSize: 8.5, letterSpacing: 1.2, color: D.amber},

  statusPill: {paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, overflow: 'hidden'},
  statusPillText: {fontFamily: D.fBold, fontSize: 8.5, letterSpacing: 1.2},

  priceChip: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'baseline', gap: 5,
    marginTop: 12, paddingVertical: 5, paddingHorizontal: 11, borderRadius: 9,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
    overflow: 'hidden',
  },
  priceFrom: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '600', letterSpacing: 1, color: D.textMute},
  priceValue: {fontFamily: D.fBold, fontSize: 12.5, letterSpacing: 0.2, color: D.accentSoft},

  noteCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    marginTop: 4, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  noteText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 17, color: D.textMute},
}));
