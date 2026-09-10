/**
 * Bravo Secure Pro — "My Pro Application" status screen.
 *
 * Shows the live application status (Pending Proposal / Proposal Ready /
 * Revision Requested / Accepted / Active / Rejected), a progress strip, the
 * submitted requirements and the event timeline. Polls while focused; the
 * realtime socket push rides on top (same push-over-poll pattern as
 * LiveTracking). The user keeps full Lite access while waiting — this screen
 * never blocks anything.
 */
import React, {useCallback, useRef} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar,
  ActivityIndicator, AppState,
} from 'react-native';
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
import {useSecureProStore} from '@store/secureProStore';
import type {ProApplication} from '@services/api';
import {PRO_STATUS_META} from './proStatus';
import {useProAppRealtime} from './useProAppRealtime';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {formatDateRanges} from '@utils/datetime';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureProStatus'>;

const POLL_MS = 5000;

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
  alert:      '#FF5D5D',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

const STEPS = ['Submitted', 'Proposal', 'Acceptance', 'Activation'] as const;

function stepState(app: ProApplication, idx: number): 'done' | 'inprog' | 'pending' | 'rejected' {
  const s = app.status;
  if (s === 'REJECTED' || s === 'CANCELLED') {return idx === 0 ? 'done' : 'rejected';}
  const doneUpTo =
    s === 'ACTIVE' ? 4 :
    s === 'ACCEPTED' ? 3 :
    s === 'PROPOSAL_CREATED' ? 2 : 1;
  if (idx < doneUpTo) {return 'done';}
  if (idx === doneUpTo) {return 'inprog';}
  return 'pending';
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short'}) +
    ' · ' + `${d.getHours()}`.padStart(2, '0') + ':' + `${d.getMinutes()}`.padStart(2, '0');
}

/** "01 Sep 2026" — the same UTC-stable "DD Mon YYYY" the other Pro screens show; "—" when absent. */
function fmtDay(iso: string | null | undefined): string {
  return formatDateRanges(iso ? [iso] : []);
}

function intendedUseLabel(app: ProApplication): string {
  const base = app.intended_use.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return app.intended_use === 'custom' && app.intended_use_note ? app.intended_use_note : base;
}

function durationLabel(app: ProApplication): string {
  if (app.duration_months) {return `${app.duration_months} month${app.duration_months > 1 ? 's' : ''}`;}
  return app.duration_note ?? 'Custom';
}

export default function SecureProStatusScreen() {
  const insets = useSafeAreaInsets();
  const {contentBottom, bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const application = useSecureProStore(st => st.application);
  const history = useSecureProStore(st => st.history);
  const isLoading = useSecureProStore(st => st.isLoading);
  const isSubmitting = useSecureProStore(st => st.isSubmitting);
  const hasLoaded = useSecureProStore(st => st.hasLoaded);
  const loadApplication = useSecureProStore(st => st.loadApplication);
  const renewPlan = useSecureProStore(st => st.renewPlan);
  const cancelApplication = useSecureProStore(st => st.cancelApplication);
  const appStateRef = useRef(AppState.currentState);

  // Withdrawal is open in every pre-activation state (never for a member
  // riding the owner's plan, never once paid — ACTIVE only expires).
  const cancellable = !!application && !application.via_owner &&
    (application.status === 'PENDING_PROPOSAL' || application.status === 'PROPOSAL_CREATED' ||
     application.status === 'REVISION_REQUESTED' || application.status === 'ACCEPTED');

  const confirmCancel = () => {
    Alert.alert(
      'Cancel this application?',
      'This withdraws your Bravo Secure Pro application. Nothing is charged, and you can apply again any time.',
      [
        {text: 'Keep it', style: 'cancel'},
        {text: 'Cancel application', style: 'destructive', onPress: () => {
          // Surface failures (e.g. ops decided concurrently) — a silent no-op
          // here reads as "withdrawn" when it wasn't.
          void cancelApplication().catch((e: Error) => {
            Alert.alert('Could not cancel', e.message || 'Please try again.');
          });
        }},
      ],
    );
  };

  useFocusEffect(
    useCallback(() => {
      void loadApplication();
      // Poll while focused AND foregrounded — a backgrounded app must not
      // burn the battery on a 5s status loop (AgentAdminApproval pattern).
      const sub = AppState.addEventListener('change', st => { appStateRef.current = st; });
      const poll = setInterval(() => {
        if (appStateRef.current === 'active') {void loadApplication();}
      }, POLL_MS);
      return () => { clearInterval(poll); sub.remove(); };
    }, [loadApplication]),
  );

  // Push-over-poll: status/thread frames from the Bravo Control System land
  // instantly via the messenger socket; the poll above stays as fallback.
  useProAppRealtime(application?.id, () => { void loadApplication(); });

  const meta = application ? PRO_STATUS_META[application.status] : null;

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
          <Text style={s.headerTitle}>My Pro Application</Text>
          <FitLine style={s.headerSub} text={'BRAVO SECURE PRO'} />
        </View>
      </View>

      {!application && !hasLoaded ? (
        <View style={s.centerFill}>
          <ActivityIndicator color={D.accent} />
        </View>
      ) : !application ? (
        <View style={s.centerFill}>
          <View style={s.emptyIcon}>
            <Icon name="shield-star" size={30} color={D.textMute} />
          </View>
          <Text style={s.emptyTitle}>No Pro application yet</Text>
          <Text style={s.emptySub}>
            Apply for Bravo Secure Pro to get a custom protection plan with a dedicated team.
          </Text>
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => navigation.replace('SecureProIntro')}
            accessibilityRole="button"
            accessibilityLabel="Explore Bravo Secure Pro">
            <LinearGradient
              colors={['#6E9BF5', D.accent, D.accentDeep]}
              locations={[0, 0.55, 1]}
              start={{x: 0, y: 0}}
              end={{x: 0, y: 1}}
              style={s.emptyCta}>
              <Text style={s.emptyCtaText}>Explore Bravo Secure Pro</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <ScrollView
            style={{flex: 1}}
            contentContainerStyle={{
              paddingHorizontal: 20,
              // Two stacked bottom buttons (EXPIRED's renew pair, or a primary
              // CTA + Cancel Application) need ~184px of clearance; a single
              // CTA needs 120. Under-padding leaves the last rows stuck under
              // the absolute overlay.
              paddingBottom: contentBottom(
                application.status === 'EXPIRED'
                || (cancellable && (application.status === 'PROPOSAL_CREATED' || application.status === 'ACCEPTED'))
                  ? 184 : 120,
              ),
            }}
            showsVerticalScrollIndicator={false}>

            {/* Status hero */}
            <LinearGradient
              colors={['rgba(20,32,60,0.78)', 'rgba(11,15,23,0.7)']}
              start={{x: 0.5, y: 0}}
              end={{x: 0.5, y: 1}}
              style={s.heroCard}>
      <ImageryBackdrop source={Imagery.proHero} variant="hero" radius={22} />
              <View style={[s.heroIcon, {borderColor: (meta?.color ?? D.accent) + '55'}]}>
                <Icon name={(meta?.icon ?? 'clock-outline') as never} size={28} color={meta?.color ?? D.accent} />
              </View>
              <View style={[s.statusPill, {backgroundColor: (meta?.color ?? '#fff') + '1A', borderColor: (meta?.color ?? '#fff') + '4D'}]}>
                <View style={[s.statusDot, {backgroundColor: meta?.color}]} />
                <Text style={[s.statusPillText, {color: meta?.color}]}>{meta?.label.toUpperCase()}</Text>
              </View>
              <Text style={s.heroCopy}>{meta?.copy}</Text>
              {application.status === 'REJECTED' && application.rejected_reason ? (
                <View style={s.rejectBox}>
                  <Text style={s.rejectLabel}>REASON</Text>
                  <Text style={s.rejectText}>{application.rejected_reason}</Text>
                </View>
              ) : null}

              {/* Progress strip */}
              <View style={s.stepsRow}>
                {STEPS.map((label, i) => {
                  const st = stepState(application, i);
                  return (
                    <View key={label} style={s.stepCell}>
                      <View style={[
                        s.stepDot,
                        st === 'done' && s.stepDotDone,
                        st === 'inprog' && s.stepDotInprog,
                        st === 'rejected' && s.stepDotRejected,
                      ]}>
                        {st === 'done' ? (
                          <Icon name="check" size={11} color="#fff" />
                        ) : st === 'inprog' ? (
                          <View style={s.stepDotInner} />
                        ) : st === 'rejected' ? (
                          <Icon name="close" size={11} color={D.alert} />
                        ) : null}
                      </View>
                      <FitLine style={[s.stepLabel, st !== 'pending' && {color: D.textDim}, {textAlign: 'center'}]} floorScale={0.7} text={label} />
                    </View>
                  );
                })}
              </View>
            </LinearGradient>

            {/* Request summary */}
            <Text style={s.sectionLabel}>YOUR REQUEST</Text>
            <View style={s.card}>
              <SummaryRow icon="briefcase-outline" label="Intended use" value={intendedUseLabel(application)} />
              <SummaryRow icon="calendar-range" label="Duration" value={durationLabel(application)} border />
              <SummaryRow icon="calendar" label="Start date" value={fmtDay(application.start_date)} border />
              <SummaryRow icon="map-marker-radius" label="Coverage area" value={application.coverage_area} border />
              <SummaryRow
                icon="account-group"
                label="Team"
                value={`${application.cpo_count} CPO · ${application.driver_count} driver · ${application.support_staff_count} support`}
                border
              />
              {application.services.length > 0 && (
                <SummaryRow
                  icon="plus-circle-multiple-outline"
                  label="Services"
                  value={application.services.map(k => k.replace(/_/g, ' ')).join(', ')}
                  border
                />
              )}
            </View>

            {/* Timeline */}
            <Text style={s.sectionLabel}>TIMELINE</Text>
            <View style={s.card}>
              {application.events.length === 0 ? (
                <Text style={s.tlEmpty}>Submitted {fmtDateTime(application.submitted_at)}</Text>
              ) : (
                application.events.map((ev, i) => (
                  <View key={ev.id} style={[s.tlRow, i > 0 && s.tlRowBorder]}>
                    <View style={s.tlDotCol}>
                      <View style={[s.tlDot, i === 0 && {backgroundColor: meta?.color ?? D.accent}]} />
                    </View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={s.tlMsg}>{ev.message ?? ev.event.replace(/[._]/g, ' ')}</Text>
                      <Text style={s.tlTs}>{fmtDateTime(ev.created_at)}</Text>
                    </View>
                  </View>
                ))
              )}
            </View>

            {/* Previous plans */}
            {history.length > 0 && (
              <>
                <Text style={s.sectionLabel}>PREVIOUS PLANS</Text>
                <View style={s.card}>
                  {history.map((h, i) => (
                    <View key={h.id} style={[s.histRow, i > 0 && s.sumRowBorder]}>
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.histTitle} numberOfLines={1}>
                          {h.intended_use.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                        </Text>
                        <Text style={s.histSub} numberOfLines={1}>
                          {h.coverage_start && h.coverage_end
                            ? `${fmtDay(h.coverage_start)} → ${fmtDay(h.coverage_end)}`
                            : `Submitted ${fmtDateTime(h.submitted_at)}`}
                          {h.total_credits ? ` · ${Number(h.total_credits).toLocaleString()} BC` : ''}
                        </Text>
                      </View>
                      <View style={[s.statusChipSm, {
                        backgroundColor: PRO_STATUS_META[h.status].color + '14',
                        borderColor: PRO_STATUS_META[h.status].color + '4D',
                      }]}>
                        <Text style={[s.statusChipSmText, {color: PRO_STATUS_META[h.status].color}]}>
                          {PRO_STATUS_META[h.status].label.toUpperCase()}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              </>
            )}

            {isLoading && (
              <View style={s.refreshRow}>
                <ActivityIndicator size="small" color={D.textMute} />
                <Text style={s.refreshText}>Checking for updates…</Text>
              </View>
            )}
          </ScrollView>

          {/* Expired — one-tap renew with old details, or a customised re-application. */}
          {application.status === 'EXPIRED' && !application.via_owner && (
            <LinearGradient
              colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
              locations={[0, 0.5]}
              style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
              <TouchableOpacity
                activeOpacity={0.9}
                disabled={isSubmitting}
                onPress={() => { void renewPlan().catch(() => undefined); }}
                accessibilityRole="button"
                accessibilityLabel="Renew with current details">
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.cta}>
                  {isSubmitting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Icon name="refresh" size={18} color="#fff" importantForAccessibility="no" />
                      <Text style={s.ctaText}>Renew With Current Details</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.ghostBtn}
                activeOpacity={0.8}
                disabled={isSubmitting}
                onPress={() => navigation.navigate('SecureProApply')}
                accessibilityRole="button"
                accessibilityLabel="Customize a new plan">
                <Text style={s.ghostText}>Customize Plan</Text>
              </TouchableOpacity>
            </LinearGradient>
          )}

          {/* Wait states — no primary CTA, but withdrawal stays open. */}
          {(application.status === 'PENDING_PROPOSAL' || application.status === 'REVISION_REQUESTED') &&
            cancellable && (
            <LinearGradient
              colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
              locations={[0, 0.5]}
              style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
              <TouchableOpacity
                style={s.ghostBtn}
                activeOpacity={0.8}
                disabled={isSubmitting}
                onPress={confirmCancel}
                accessibilityRole="button"
                accessibilityLabel="Cancel application">
                <Text style={[s.ghostText, {color: D.alert}]}>Cancel Application</Text>
              </TouchableOpacity>
            </LinearGradient>
          )}

          {/* Status-dependent CTA */}
          {(application.status === 'PROPOSAL_CREATED' || application.status === 'ACCEPTED' ||
            application.status === 'ACTIVE' || application.status === 'REJECTED' ||
            application.status === 'CANCELLED') && (
            <LinearGradient
              colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
              locations={[0, 0.5]}
              style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={() => {
                  if (application.status === 'PROPOSAL_CREATED') {
                    navigation.navigate('SecureProProposal', {applicationId: application.id});
                  } else if (application.status === 'ACCEPTED') {
                    navigation.navigate('SecureProPayment', {applicationId: application.id});
                  } else if (application.status === 'REJECTED' || application.status === 'CANCELLED') {
                    // REJECTED/CANCELLED close the slot server-side — a fresh form starts over.
                    navigation.navigate('SecureProApply');
                  } else {
                    navigation.navigate('ProDashboard');
                  }
                }}
                accessibilityRole="button">
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.cta}>
                  <Icon
                    name={application.status === 'PROPOSAL_CREATED' ? 'file-document-outline'
                      : application.status === 'ACCEPTED' ? 'credit-card-outline'
                      : (application.status === 'REJECTED' || application.status === 'CANCELLED') ? 'refresh'
                      : 'view-dashboard-outline'}
                    size={18} color="#fff" importantForAccessibility="no" />
                  <Text style={s.ctaText}>
                    {application.status === 'PROPOSAL_CREATED' ? 'View Proposal'
                      : application.status === 'ACCEPTED' ? 'Pay & Activate'
                      : (application.status === 'REJECTED' || application.status === 'CANCELLED') ? 'Apply Again'
                      : 'Open Pro Dashboard'}
                  </Text>
                </LinearGradient>
              </TouchableOpacity>
              {cancellable && (
                <TouchableOpacity
                  style={s.ghostBtn}
                  activeOpacity={0.8}
                  disabled={isSubmitting}
                  onPress={confirmCancel}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel application">
                  <Text style={[s.ghostText, {color: D.alert}]}>Cancel Application</Text>
                </TouchableOpacity>
              )}
            </LinearGradient>
          )}
        </>
      )}
    </View>
  );
}

function SummaryRow({icon, label, value, border}: {
  icon: React.ComponentProps<typeof Icon>['name']; label: string; value: string; border?: boolean;
}) {
  return (
    <View style={[s.sumRow, border && s.sumRowBorder]}>
      <View style={s.sumIcon}>
        <Icon name={icon} size={15} color={D.accentSoft} />
      </View>
      <Text style={s.sumLabel}>{label}</Text>
      <Text style={s.sumValue} numberOfLines={2}>{value}</Text>
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

  centerFill: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 10},
  emptyIcon: {
    width: 64, height: 64, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  emptyTitle: {color: D.text, fontFamily: D.fBold, fontSize: 17},
  emptySub: {color: D.textMute, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, textAlign: 'center'},
  emptyCta: {
    minHeight: 50, borderRadius: 15, paddingHorizontal: 26, marginTop: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  emptyCtaText: {fontFamily: D.fBold, fontSize: 14.5, color: '#fff'},

  heroCard: {borderRadius: 22, padding: 20, borderWidth: 1, borderColor: D.hair2, overflow: 'hidden', alignItems: 'center'},
  heroIcon: {
    width: 58, height: 58, borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: 99, borderWidth: 1, marginTop: 13,
  },
  statusDot: {width: 7, height: 7, borderRadius: 4},
  statusPillText: {fontFamily: D.fMono, fontSize: 10, fontWeight: '800', letterSpacing: 1.4},
  heroCopy: {color: D.textDim, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 19, textAlign: 'center', marginTop: 12},

  rejectBox: {
    alignSelf: 'stretch', marginTop: 14, padding: 12, borderRadius: 12,
    backgroundColor: 'rgba(255,93,93,0.08)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.3)',
  },
  rejectLabel: {color: D.alert, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1.4},
  rejectText: {color: D.textDim, fontFamily: D.fSans, fontSize: 12, lineHeight: 17, marginTop: 5},

  stepsRow: {flexDirection: 'row', alignSelf: 'stretch', marginTop: 18, gap: 6},
  stepCell: {flex: 1, alignItems: 'center', gap: 7},
  stepDot: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 1.5, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  stepDotDone: {backgroundColor: D.accent, borderColor: D.accent},
  stepDotInprog: {borderColor: D.accentSoft},
  stepDotRejected: {borderColor: 'rgba(255,93,93,0.5)'},
  stepDotInner: {width: 8, height: 8, borderRadius: 4, backgroundColor: D.accentSoft},
  stepLabel: {color: D.textMute, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase'},

  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 22, marginBottom: 10,
  },
  card: {
    borderRadius: 16, backgroundColor: 'rgba(22,27,37,0.72)',
    borderWidth: 1, borderColor: D.hair, overflow: 'hidden',
  },

  sumRow: {flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 12},
  sumRowBorder: {borderTopWidth: 1, borderTopColor: D.hair},
  sumIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  sumLabel: {minWidth: 92, maxWidth: 130, flexShrink: 0, color: D.textMute, fontFamily: D.fSans, fontSize: 11.5},
  sumValue: {flex: 1, minWidth: 0, color: D.text, fontFamily: D.fSemi, fontSize: 12.5, textAlign: 'right'},

  tlEmpty: {color: D.textMute, fontFamily: D.fSans, fontSize: 12, padding: 14},
  tlRow: {flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 12},
  tlRowBorder: {borderTopWidth: 1, borderTopColor: D.hair},
  tlDotCol: {paddingTop: 4},
  tlDot: {width: 9, height: 9, borderRadius: 5, backgroundColor: D.hair2},
  tlMsg: {color: D.text, fontFamily: D.fSemi, fontSize: 12.5, lineHeight: 18},
  tlTs: {color: D.textMute, fontFamily: D.fMono, fontSize: 10, marginTop: 3},

  refreshRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 14},
  refreshText: {color: D.textMute, fontFamily: D.fSans, fontSize: 11},

  histRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12},
  histTitle: {color: D.text, fontFamily: D.fSemi, fontSize: 13},
  histSub: {color: D.textMute, fontFamily: D.fMono, fontSize: 10, marginTop: 4, letterSpacing: 0.3},
  statusChipSm: {flexShrink: 0, maxWidth: '45%', paddingVertical: 4, paddingHorizontal: 8, borderRadius: 7, borderWidth: 1},
  statusChipSmText: {fontFamily: D.fMono, fontSize: 8, fontWeight: '800', letterSpacing: 0.9},
  ghostBtn: {
    minHeight: 48, borderRadius: 15, marginTop: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  ghostText: {color: D.textDim, fontFamily: D.fSemi, fontSize: 13.5},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 56, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 15.5, letterSpacing: 0.3, color: '#fff'},
}));
