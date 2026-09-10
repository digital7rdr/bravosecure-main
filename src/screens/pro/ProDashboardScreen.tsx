/**
 * Bravo Secure Pro — dashboard hub (mock page 14).
 *
 * Central hub for an ACTIVE Pro plan: welcome header with plan status +
 * next payment, and the module grid (AI Itinerary, Designated Team, Live
 * Map, Messenger, Virtual Bodyguard, Linked Members, Activity & Reports,
 * Billing & Credits — plus Booking Requests / Documents / Additional
 * Services as COMING SOON until their flows land). Unlocked by an ACTIVE
 * Pro application — and ONLY that; everyone else is redirected to the
 * application status screen.
 *
 * Audit Rev2 SP-01 — this used to read "OR a legacy M1A Bravo Secure Pro
 * subscription", implemented as isProActive(user), i.e. the MESSENGER
 * subscription tier. That let a 2500 BC messenger purchase open the Secure
 * Pro dashboard for free. See the gate below.
 */
import React, {useCallback, useMemo, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, Image,
  type ImageSourcePropType} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useAuthStore} from '@store/authStore';
import {useSecureProStore} from '@store/secureProStore';
import {useProPlanGate} from '@hooks/useProPlanGate';
import {useProAppRealtime} from '@screens/securepro/useProAppRealtime';
import {secureProApi, type ProPlanMission} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import ActivityBell from '@components/ActivityBell';
import {ProfileDrawerModal} from '@components/ProfileDrawerModal';
import {regionDef} from '@utils/regions';
import {useBookingStore} from '@store/bookingStore';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ProDashboard'>;

const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  signal:     '#4ADE80',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

type IconName = React.ComponentProps<typeof Icon>['name'];

interface ModuleDef {
  key: string;
  title: string;
  desc: string;
  icon: IconName;
  /** BookingStack route, or a root tab name for cross-tab jumps. */
  target?: keyof BookingStackParamList | 'MessengerTab';
  comingSoon?: boolean;
  /** Optional brand photo behind the card. Modules without one stay flat. */
  img?: ImageSourcePropType;
  /** 'art' for the client's purpose-made card art (2026-08-26 drop): it
   *  carries its own obsidian ground, so it renders full-strength with only a
   *  light copy-zone gradient. Default 'card' for full-bleed photos. */
  imgVariant?: 'card' | 'art';
}

const MODULES: ModuleDef[] = [
  {key: 'itinerary', title: 'AI Itinerary', desc: 'Coverage calendar — booked dates highlighted', icon: 'calendar-month-outline', target: 'SecureProCalendar', img: Imagery.proItinerary, imgVariant: 'art'},
  {key: 'team', title: 'Designated Team', desc: 'Your assigned team & vehicles', icon: 'account-group', target: 'ProAssignedTeam', img: Imagery.proDesignatedTeam, imgVariant: 'art'},
  {key: 'livemap', title: 'Live Map', desc: 'Track your detail in real time', icon: 'map-marker-radius', target: 'ProLiveMission', img: Imagery.proLiveMap, imgVariant: 'art'},
  {key: 'bookings', title: 'Booking Requests', desc: 'Request protection dates in your period', icon: 'email-check-outline', target: 'SecureProMissions', img: Imagery.proBookingRequests, imgVariant: 'art'},
  {key: 'messenger', title: 'Messenger', desc: 'Secure encrypted communications', icon: 'message-lock-outline', target: 'MessengerTab', img: Imagery.messengerExec},
  {key: 'vbg', title: 'Virtual Bodyguard', desc: 'Journey monitoring, alerts & safety tools', icon: 'shield-account', target: 'VBGHome', img: Imagery.vbgCompanion},
  {key: 'members', title: 'Linked Members', desc: 'Manage members & permissions', icon: 'account-multiple-plus-outline', target: 'SecureProMembers', img: Imagery.proLinkedMembers},
  {key: 'documents', title: 'Documents', desc: 'Verify & manage documents', icon: 'file-document-multiple-outline', comingSoon: true},
  {key: 'reports', title: 'Activity & Reports', desc: 'Bookings, logs & operational reports', icon: 'chart-box-outline', target: 'ProActivityHistory', img: Imagery.proReports, imgVariant: 'art'},
  {key: 'billing', title: 'Billing & Credits', desc: 'Balance, invoices & payment history', icon: 'credit-card-outline', target: 'Credits', img: Imagery.proBilling},
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'});
}

export default function ProDashboardScreen() {
  const insets = useSafeAreaInsets();
  const {contentBottom} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const user = useAuthStore(s => s.user);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const application = useSecureProStore(st => st.application);

  // Audit Rev2 SP-01 — the activation gate is the shared useProPlanGate hook,
  // mounted by EVERY screen behind the Secure Pro paywall (not just this one).
  // It loads the application on focus and replaces to SecureProStatus when the
  // plan is not ACTIVE. The old inline gate had a `legacyPro = isProActive(user)`
  // term that read the MESSENGER subscription_tier — a different product that
  // merely shares the lite/pro/enterprise vocabulary — so buying Messenger Pro
  // unlocked this dashboard for free. Family members are covered because
  // /pro-applications/me returns the OWNER's ACTIVE row to a linked member.
  const {planActive} = useProPlanGate();

  const firstName = (user?.full_name ?? '').split(' ')[0] || 'there';

  // Founder 2026-08-24 — header region chip, same source + fallback as
  // BookingHome so the two screens can never disagree about the region.
  const draftZone = useBookingStore(st => st.draft.zone_code);
  const chipRegion = regionDef(draftZone) ?? regionDef('AE')!;

  // ── Live Map is a mission-day surface ────────────────────────────────────────
  // Founder 2026-08-24: "live map will activate on the requested date only — on
  // that day it will activate and show the mission." Same dataset the coverage
  // calendar already highlights (`secureProApi.missions`, refreshed on focus and
  // on the Pro realtime channel), so the tile and the calendar can never disagree.
  const [missions, setMissions] = useState<ProPlanMission[]>([]);
  const appId = application?.id;
  const loadMissions = useCallback(async () => {
    if (!appId) {return;}
    try {
      const {data} = await secureProApi.missions(appId);
      setMissions(data.missions);
    } catch {
      // Keep the last good list — a failed poll must not lock a live mission day.
    }
  }, [appId]);
  useFocusEffect(useCallback(() => { void loadMissions(); }, [loadMissions]));
  useProAppRealtime(appId, () => { void loadMissions(); });

  // Only SCHEDULED counts. A REQUESTED date has no assigned team yet, so there is
  // nothing for a live map to track — offering it would be the empty-screen bug.
  const scheduledDates = useMemo(() => {
    const set = new Set<string>();
    for (const mi of missions) {
      if (mi.status !== 'SCHEDULED') {continue;}
      for (const d of mi.mission_dates) {set.add(d);}
    }
    return set;
  }, [missions]);

  const today = new Date().toISOString().slice(0, 10);
  const liveToday = scheduledDates.has(today);
  const nextMissionDate = useMemo(
    () => [...scheduledDates].filter(d => d >= today).sort()[0] ?? null,
    [scheduledDates, today],
  );

  /** Why a tile is closed, and what it says instead of its normal subtitle. */
  const gateFor = (m: ModuleDef): {locked: boolean; pill: string | null; desc: string} => {
    if (m.comingSoon) {return {locked: true, pill: 'SOON', desc: m.desc};}
    if (m.key === 'livemap' && !liveToday) {
      return {
        locked: true,
        pill: 'MISSION DAY',
        // Say WHEN, not just "no". A dead tile with no reason is the worse bug.
        desc: nextMissionDate
          ? `Activates ${fmtDate(nextMissionDate)}`
          : 'Activates on a scheduled mission date',
      };
    }
    return {locked: false, pill: null, desc: m.desc};
  };

  const openModule = (m: ModuleDef) => {
    if (m.comingSoon || !m.target) {return;}
    if (m.target === 'MessengerTab') {
      navigation.navigate('MessengerTab' as never);
    } else {
      navigation.navigate(m.target as never);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View pointerEvents="none" style={s.ambient} />

      {/* Header */}
      <View style={s.header}>
        {/**
         * B-661 — the chevron only renders when there is somewhere to go.
         *
         * This screen is now ALSO the Secure shell's Home tab for a PRO client
         * (it used to only ever be pushed). At a tab root there is nothing to
         * pop, so an unconditional chevron is a control that visibly does
         * nothing — the dead-back class this repo has already paid for twice
         * (B-261 / the BB back audit). A width-matched spacer keeps the title
         * in the same place either way, so the header does not shift between
         * the pushed and tab-root presentations.
         */}
        {navigation.canGoBack() ? (
          <TouchableOpacity
            style={s.back}
            onPress={() => goBackOnce(navigation)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="chevron-left" size={20} color={D.text} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={s.headerAvatar}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Open profile drawer"
            onPress={() => setDrawerOpen(true)}>
            {user?.avatar_url ? (
              <Image source={{uri: user.avatar_url}} style={s.headerAvatarImg} />
            ) : (
              <Text style={s.headerAvatarText}>
                {(user?.full_name ?? user?.email ?? 'B').slice(0, 2).toUpperCase()}
              </Text>
            )}
          </TouchableOpacity>
        )}
        <View style={{flex: 1, minWidth: 0}}>
          {/* Founder 2026-08-24: the plan pill compacts into the label row so
              the header's right side frees up for the bell + region chip. */}
          <View style={s.labelRow}>
            <Text style={s.headerLabel} numberOfLines={1}>BRAVO SECURE PRO</Text>
            <View style={s.activePill}>
              <View style={s.activeDot} />
              <Text style={s.activePillText} numberOfLines={1}>
                {application?.via_owner
                  ? `UNDER ${application.via_owner.name.split(' ')[0].toUpperCase()}`
                  : 'ACTIVE'}
              </Text>
            </View>
          </View>
          {/* A long first name compresses to fit instead of ellipsizing
              mid-name ("Shira…") — FitLine, because the native pair this used
              is nondeterministic under Fabric (see FitLine's docblock). */}
          <FitLine
            style={s.headerTitle}
            floorScale={0.72}
            text={`Welcome back, ${firstName}`}
          />
        </View>
        {/* N-18/GAP-3 — the same durable-inbox bell BookingHome mounts. */}
        <ActivityBell onPress={() => navigation.navigate('ActivityCenter')} />
        {/* The canonical region selector (ZoneMap), same chip as BookingHome. */}
        <TouchableOpacity
          style={s.regionBtn}
          activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          accessibilityRole="button"
          accessibilityLabel={`Change region, currently ${chipRegion.name}`}
          onPress={() => navigation.navigate('ZoneMap')}>
          <Text style={s.flagText}>{chipRegion.flag}</Text>
          <Icon name="chevron-down" size={13} color={D.textDim} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(24)}}
        showsVerticalScrollIndicator={false}>

        {/* Plan strip */}
        <LinearGradient
          colors={['rgba(20,32,60,0.78)', 'rgba(11,15,23,0.7)']}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={s.planCard}>
          <View style={s.planCell}>
            <FitLine style={s.planCap} floorScale={0.7} text="COVERED UNTIL" />
            <Text style={s.planVal}>
              {planActive ? fmtDate(application?.covered_until ?? application?.current_period_end) : '—'}
            </Text>
          </View>
          <View style={s.planDivider} />
          <View style={s.planCell}>
            <FitLine style={s.planCap} floorScale={0.7} text="PLAN TOTAL" />
            <Text style={s.planVal}>
              {planActive && application?.proposal
                ? `${application.proposal.total_credits.toLocaleString()} BC`
                : '—'}
            </Text>
          </View>
          <View style={s.planDivider} />
          <TouchableOpacity
            style={s.planCell}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="View my Pro application"
            onPress={() => navigation.navigate('SecureProStatus')}>
            <FitLine style={s.planCap} floorScale={0.7} text="PLAN" />
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 4}}>
              <Text style={[s.planVal, {color: D.accentSoft}]}>Details</Text>
              <Icon name="chevron-right" size={14} color={D.accentSoft} />
            </View>
          </TouchableOpacity>
        </LinearGradient>

        {/* Founder 2026-08-24: the Request Protection banner is REMOVED from Pro.
            A Pro session is scheduled through Booking Requests and approved in the
            ops console, so an always-live "start a session now" door promised
            something the plan does not do. It was also a second route to
            ProLiveMission — the Live Map module still opens that screen, so no
            destination was lost. */}

        {/* Founder 2026-08-26 — Additional Services takes the banner slot the
            Request Protection card used to hold (annotated screenshot). Same
            full-width shape; it leaves the grid below. */}
        <TouchableOpacity
          style={s.addonsBanner}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Additional Services — request extra support or add-ons"
          onPress={() => navigation.navigate('ServiceType')}>
          <ImageryBackdrop source={Imagery.svcConsultation} variant="card" radius={18} />
          <View style={s.addonsIcon}>
            <Icon name="plus-circle-outline" size={22} color={D.accentSoft} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <FitLine style={s.addonsTitle} floorScale={0.8} text="Additional Services" />
            <Text style={s.addonsDesc} numberOfLines={2}>Request extra support or add-ons</Text>
          </View>
          <Icon name="chevron-right" size={20} color={D.textMute} />
        </TouchableOpacity>

        {/* Module grid */}
        <Text style={s.sectionLabel}>YOUR PRO MODULES</Text>
        <View style={s.grid}>
          {MODULES.map(m => {
            const g = gateFor(m);
            return (
              <TouchableOpacity
                key={m.key}
                style={[s.tile, g.locked && s.tileLocked]}
                activeOpacity={g.locked ? 1 : 0.82}
                onPress={() => { if (!g.locked) {openModule(m);} }}
                accessibilityRole="button"
                accessibilityLabel={g.locked ? `${m.title}. ${g.desc}` : m.title}
                accessibilityState={{disabled: g.locked}}>
                {!!m.img && (
                  <ImageryBackdrop source={m.img} variant={m.imgVariant ?? 'card'} radius={18} />
                )}
                <View style={s.tileTopLight} />
                <View style={s.tileHead}>
                  <View style={[s.tileIcon, !g.locked && s.tileIconLive]}>
                    <Icon name={m.icon} size={19} color={g.locked ? D.textMute : D.accentSoft} />
                  </View>
                  {g.pill && (
                    <View style={s.soonPill}>
                      <Text style={s.soonPillText}>{g.pill}</Text>
                    </View>
                  )}
                </View>
                <FitLine style={[s.tileTitle, g.locked && {color: D.textDim}]} floorScale={0.78} text={m.title} />
                <Text style={s.tileDesc} numberOfLines={2}>{g.desc}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={s.noteCard}>
          <Icon name="shield-check" size={15} color={D.accentSoft} />
          <Text style={s.noteText}>
            Your linked family members are automatically available under this plan. The Bravo
            Control System manages approvals, pricing and team allocations.
          </Text>
        </View>
      </ScrollView>

      <ProfileDrawerModal visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
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
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
  },
  headerAvatar: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
  },
  headerAvatarImg: {width: 40, height: 40, borderRadius: 12},
  headerAvatarText: {color: D.accentSoft, fontFamily: D.fBold, fontSize: 13},
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerLabel: {flexShrink: 1, minWidth: 0, fontFamily: D.fMono, fontSize: 9, fontWeight: '700', letterSpacing: 1.8, color: D.accentSoft},
  labelRow: {flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0},
  // Same recipe as BookingHome's regionBtn, flag-only (the header also holds
  // the bell, so the three-part badge text would re-crowd the title).
  regionBtn: {flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair},
  flagText: {fontSize: 14},
  headerTitle: {fontFamily: D.fBold, fontSize: 18.5, letterSpacing: -0.4, color: D.text, marginTop: 4},
  activePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0, maxWidth: '62%',
    paddingVertical: 5, paddingHorizontal: 10, borderRadius: 99,
    backgroundColor: 'rgba(74,222,128,0.1)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.4)',
  },
  activeDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: D.signal},
  activePillText: {color: D.signal, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1.1},

  planCard: {
    flexDirection: 'row', alignItems: 'stretch',
    borderRadius: 18, paddingVertical: 16, paddingHorizontal: 8,
    borderWidth: 1, borderColor: D.hair2, overflow: 'hidden',
  },
  planCell: {flex: 1, alignItems: 'center', gap: 6, paddingHorizontal: 4},
  planDivider: {width: 1, backgroundColor: D.hair2},
  planCap: {color: D.textMute, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1.2, textAlign: 'center'},
  planVal: {color: D.text, fontFamily: D.fBold, fontSize: 13.5, textAlign: 'center'},

  addonsBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 13,
    borderRadius: 18, padding: 15, marginBottom: 18,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
    overflow: 'hidden',
  },
  addonsIcon: {
    width: 46, height: 46, borderRadius: 14, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  addonsTitle: {fontFamily: D.fBold, fontSize: 15.5, color: D.text},
  addonsDesc: {fontFamily: D.fSans, fontSize: 12, color: D.textDim, marginTop: 2},
  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 22, marginBottom: 12,
  },
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 11},
  tile: {
    width: '48%', flexGrow: 1, minWidth: 150,
    borderRadius: 18, padding: 14,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
    overflow: 'hidden',
  },
  tileLocked: {opacity: 0.55},
  tileTopLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, backgroundColor: 'rgba(120,160,255,0.22)'},
  tileHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  tileIcon: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  tileIconLive: {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.35)'},
  soonPill: {
    flexShrink: 1,
    paddingVertical: 3, paddingHorizontal: 7, borderRadius: 6,
    backgroundColor: 'rgba(245,181,68,0.10)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.34)',
  },
  soonPillText: {fontFamily: D.fBold, fontSize: 8, letterSpacing: 1.1, color: D.amber},
  tileTitle: {color: D.text, fontFamily: D.fBold, fontSize: 13.5, marginTop: 12},
  tileDesc: {color: D.textMute, fontFamily: D.fSans, fontSize: 10.5, lineHeight: 14.5, marginTop: 4},

  noteCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    marginTop: 18, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
  },
  noteText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 17, color: D.textDim},
}));
