/**
 * Bravo Secure Pro — proposal review (page 11).
 *
 * Shows the Bravo Control System's custom proposal: number, validity,
 * coverage period, included services, assigned team, monthly Bravo Credits
 * and terms. Accept → payment screen; Request Changes → REVISION_REQUESTED
 * with a message into the application thread.
 */
import React, {useCallback, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar,
  TextInput, Modal, Pressable, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useSecureProStore} from '@store/secureProStore';
import {useProAppRealtime} from './useProAppRealtime';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureProProposal'>;

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
  alert:      '#FF5D5D',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) {return '—';}
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'});
}

function svcLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function SecureProProposalScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad, contentBottom} = useBottomInset();
  // Why: the changes sheet is a transparent Modal under edge-to-edge — it owns
  // its own bottom inset (nav bar when the IME is closed, keyboard when it is up).
  const {bottomPad: kbBottomPad} = useKeyboardLayout();
  const navigation = useNavigation<Nav>();
  const application = useSecureProStore(st => st.application);
  const isSubmitting = useSecureProStore(st => st.isSubmitting);
  const storeError = useSecureProStore(st => st.error);
  const loadApplication = useSecureProStore(st => st.loadApplication);
  const acceptProposal = useSecureProStore(st => st.acceptProposal);
  const requestChanges = useSecureProStore(st => st.requestChanges);

  const [changesOpen, setChangesOpen] = useState(false);
  const [changesText, setChangesText] = useState('');

  useFocusEffect(useCallback(() => { void loadApplication(); }, [loadApplication]));
  useProAppRealtime(application?.id, () => { void loadApplication(); });

  const proposal = application?.proposal ?? null;
  const expired = proposal ? new Date(proposal.valid_until).getTime() < Date.now() : false;
  const reviewable = application?.status === 'PROPOSAL_CREATED';

  const handleAccept = async () => {
    try {
      await acceptProposal();
      if (application) {
        navigation.replace('SecureProPayment', {applicationId: application.id});
      }
    } catch {
      // surfaced via storeError
    }
  };

  const handleRequestChanges = async () => {
    if (changesText.trim().length < 3) {return;}
    try {
      await requestChanges(changesText.trim());
      setChangesOpen(false);
      navigation.replace('SecureProStatus');
    } catch {
      // surfaced via storeError inside the modal
    }
  };

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
          <Text style={s.headerTitle}>Your Pro Proposal</Text>
          <FitLine style={s.headerSub} text={proposal ? `PROPOSAL ${proposal.proposal_number}${proposal.version > 1 ? ` · V${proposal.version}` : ''}` : 'BRAVO SECURE PRO'} />
        </View>
      </View>

      {!proposal ? (
        <View style={s.centerFill}>
          <ActivityIndicator color={D.accent} />
          <Text style={s.centerText}>Loading your proposal…</Text>
        </View>
      ) : (
        <>
          <ScrollView
            style={{flex: 1}}
            contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(150)}}
            showsVerticalScrollIndicator={false}>

            {/* Price hero — ONE total for the whole coverage period. */}
            <LinearGradient
              colors={['rgba(20,32,60,0.78)', 'rgba(11,15,23,0.7)']}
              start={{x: 0.5, y: 0}}
              end={{x: 0.5, y: 1}}
              style={s.heroCard}>
      <ImageryBackdrop source={Imagery.svcConsultation} variant="hero" radius={22} />
              <Text style={s.heroLabel}>TOTAL · FULL COVERAGE PERIOD</Text>
              <View style={s.heroPriceRow}>
                <Text style={s.heroPrice}>{proposal.total_credits.toLocaleString()}</Text>
                <Text style={s.heroPriceUnit}>BC total</Text>
              </View>
              <View style={[s.validPill, expired && s.validPillExpired]}>
                <Icon name={expired ? 'alert-circle-outline' : 'clock-outline'} size={13}
                  color={expired ? D.alert : D.textDim} />
                <Text style={[s.validText, expired && {color: D.alert}]}>
                  {expired ? `Expired ${fmtDate(proposal.valid_until)}` : `Valid until ${fmtDate(proposal.valid_until)}`}
                </Text>
              </View>
            </LinearGradient>

            {/* Coverage */}
            <Text style={s.sectionLabel}>SERVICE PERIOD</Text>
            <View style={s.card}>
              <View style={s.periodRow}>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.periodCap}>FROM</Text>
                  <Text style={s.periodVal}>{fmtDate(proposal.coverage_start)}</Text>
                </View>
                <Icon name="arrow-right" size={16} color={D.textMute} />
                <View style={{flex: 1, minWidth: 0, alignItems: 'flex-end'}}>
                  <Text style={s.periodCap}>TO</Text>
                  <Text style={s.periodVal}>{fmtDate(proposal.coverage_end)}</Text>
                </View>
              </View>
            </View>

            {/* Included services */}
            <Text style={s.sectionLabel}>INCLUDED SERVICES</Text>
            <View style={s.card}>
              {proposal.included_services.length === 0 ? (
                <Text style={s.emptyLine}>—</Text>
              ) : proposal.included_services.map((k, i) => (
                <View key={k} style={[s.svcRow, i > 0 && s.rowBorder]}>
                  <Icon name="check-circle" size={16} color={D.signal} />
                  <Text style={s.svcText}>{svcLabel(k)}</Text>
                </View>
              ))}
            </View>

            {/* Assigned team */}
            <Text style={s.sectionLabel}>ASSIGNED TEAM</Text>
            <View style={s.card}>
              {proposal.assigned_team.length === 0 ? (
                <Text style={s.emptyLine}>Team assignment follows activation.</Text>
              ) : proposal.assigned_team.map((t, i) => (
                <View key={`${t.role}-${i}`} style={[s.teamRow, i > 0 && s.rowBorder]}>
                  <View style={s.teamIcon}>
                    <Icon name="account" size={15} color={D.accentSoft} />
                  </View>
                  <Text style={s.teamRole} numberOfLines={1}>
                    {t.role}{t.label ? ` · ${t.label}` : ''}
                  </Text>
                  <Text style={s.teamCount}>×{t.count}</Text>
                </View>
              ))}
            </View>

            {/* Terms */}
            {proposal.terms ? (
              <>
                <Text style={s.sectionLabel}>TERMS</Text>
                <View style={s.card}>
                  <Text style={s.termsText}>{proposal.terms}</Text>
                </View>
              </>
            ) : null}

            {storeError ? <Text style={s.errText}>{storeError}</Text> : null}
            {!reviewable && application ? (
              <Text style={s.stateHint}>
                {application.status === 'ACCEPTED'
                  ? 'You accepted this proposal — continue to payment from the status screen.'
                  : application.status === 'REVISION_REQUESTED'
                    ? 'Changes requested — the Bravo Control System is revising this proposal.'
                    : null}
              </Text>
            ) : null}
          </ScrollView>

          {/* CTAs */}
          {reviewable && (
            <LinearGradient
              colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
              locations={[0, 0.4]}
              style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={() => { void handleAccept(); }}
                disabled={isSubmitting || expired}
                accessibilityRole="button"
                accessibilityLabel="Accept proposal"
                accessibilityState={{disabled: isSubmitting || expired}}>
                <LinearGradient
                  colors={expired
                    ? ['rgba(91,141,239,0.35)', 'rgba(91,141,239,0.35)', 'rgba(47,91,224,0.35)']
                    : ['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.cta}>
                  {isSubmitting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Icon name="check-decagram" size={18} color="#fff" importantForAccessibility="no" />
                      <Text style={s.ctaText}>{expired ? 'Proposal Expired' : 'Accept Proposal'}</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.ghostBtn}
                activeOpacity={0.8}
                disabled={isSubmitting}
                onPress={() => { setChangesText(''); setChangesOpen(true); }}
                accessibilityRole="button"
                accessibilityLabel="Request changes">
                <Text style={s.ghostText}>Request Changes</Text>
              </TouchableOpacity>
            </LinearGradient>
          )}
        </>
      )}

      {/* Request-changes sheet */}
      <Modal visible={changesOpen} transparent animationType="slide" onRequestClose={() => setChangesOpen(false)}>
        <Pressable style={s.sheetBackdrop} onPress={() => { if (!isSubmitting) {setChangesOpen(false);} }}>
          <Pressable style={[s.sheetCard, {paddingBottom: kbBottomPad(24)}]} onPress={() => {}}>
            <Text style={s.sheetTitle}>Request Changes</Text>
            <Text style={s.sheetSub}>
              Tell the Bravo Control System what you'd like adjusted — they'll send a revised proposal.
            </Text>
            <TextInput
              style={s.sheetInput}
              value={changesText}
              onChangeText={setChangesText}
              placeholder="e.g. We need one more driver and coverage starting a week later…"
              placeholderTextColor={D.textMute}
              selectionColor={D.accent}
              multiline
              maxLength={2000}
              textAlignVertical="top"
              autoFocus
            />
            {storeError ? <Text style={s.errText}>{storeError}</Text> : null}
            <TouchableOpacity
              activeOpacity={0.9}
              disabled={isSubmitting || changesText.trim().length < 3}
              onPress={() => { void handleRequestChanges(); }}
              accessibilityRole="button"
              accessibilityLabel="Send change request">
              <LinearGradient
                colors={changesText.trim().length < 3
                  ? ['rgba(91,141,239,0.35)', 'rgba(91,141,239,0.35)', 'rgba(47,91,224,0.35)']
                  : ['#6E9BF5', D.accent, D.accentDeep]}
                locations={[0, 0.55, 1]}
                start={{x: 0, y: 0}}
                end={{x: 0, y: 1}}
                style={s.sheetCta}>
                {isSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaText}>Send Request</Text>}
              </LinearGradient>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
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

  centerFill: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12},
  centerText: {color: D.textMute, fontFamily: D.fSans, fontSize: 12.5},

  heroCard: {
    borderRadius: 22, padding: 22, borderWidth: 1, borderColor: D.hair2,
    overflow: 'hidden', alignItems: 'center',
  },
  heroLabel: {color: D.textMute, fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.8},
  heroPriceRow: {flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 10},
  heroPrice: {color: D.text, fontFamily: D.fBold, fontSize: 38, letterSpacing: -1},
  heroPriceUnit: {color: D.accentSoft, fontFamily: D.fSemi, fontSize: 14},
  validPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14,
    paddingVertical: 6, paddingHorizontal: 12, borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  validPillExpired: {backgroundColor: 'rgba(255,93,93,0.08)', borderColor: 'rgba(255,93,93,0.3)'},
  validText: {color: D.textDim, fontFamily: D.fSemi, fontSize: 11.5},

  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 22, marginBottom: 10,
  },
  card: {
    borderRadius: 16, backgroundColor: 'rgba(22,27,37,0.72)',
    borderWidth: 1, borderColor: D.hair, overflow: 'hidden',
  },
  rowBorder: {borderTopWidth: 1, borderTopColor: D.hair},
  emptyLine: {color: D.textMute, fontFamily: D.fSans, fontSize: 12, padding: 14},

  periodRow: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16},
  periodCap: {color: D.textMute, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1.2},
  periodVal: {color: D.text, fontFamily: D.fBold, fontSize: 14.5, marginTop: 4},

  svcRow: {flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 12},
  svcText: {flex: 1, minWidth: 0, color: D.text, fontFamily: D.fSemi, fontSize: 13},

  teamRow: {flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 12},
  teamIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  teamRole: {flex: 1, minWidth: 0, color: D.text, fontFamily: D.fSemi, fontSize: 13},
  teamCount: {color: D.accentSoft, fontFamily: D.fBold, fontSize: 13.5},

  termsText: {color: D.textDim, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 19, padding: 14},

  errText: {color: D.alert, fontFamily: D.fSemi, fontSize: 11.5, textAlign: 'center', marginTop: 14},
  stateHint: {color: D.textMute, fontFamily: D.fSans, fontSize: 11.5, textAlign: 'center', marginTop: 14, lineHeight: 17},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 56, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 15.5, letterSpacing: 0.3, color: '#fff'},
  ghostBtn: {
    minHeight: 48, borderRadius: 15, marginTop: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  ghostText: {color: D.textDim, fontFamily: D.fSemi, fontSize: 13.5},

  sheetBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)'},
  sheetCard: {
    backgroundColor: '#10151F', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 20,
  },
  sheetTitle: {color: D.text, fontFamily: D.fBold, fontSize: 17},
  sheetSub: {color: D.textMute, fontFamily: D.fSans, fontSize: 12, lineHeight: 17, marginTop: 6},
  sheetInput: {
    marginTop: 14, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    color: D.text, fontFamily: D.fSans, fontSize: 13.5, minHeight: 100,
  },
  sheetCta: {
    minHeight: 52, borderRadius: 15, marginTop: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
}));
