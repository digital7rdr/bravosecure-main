/**
 * Trip Summary
 *
 * Read-only view of a completed or cancelled booking. Shows the booking
 * suffix (matching the ops console — last 12 chars), route, status,
 * total paid, assigned team (if any), and timestamps. Reached by tapping
 * a terminal-state row in Recent Bookings on BookingHomeScreen.
 */
import React, {useEffect, useState} from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StatusBar, StyleSheet, TextInput, ActivityIndicator,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useRoute} from '@react-navigation/native';
import type {NativeStackNavigationProp, NativeStackScreenProps} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {UI} from '@components/ui/tokens';
import {bookingApi, assignmentApi, type AssignedCpoDto, type AssignedVehicleDto} from '@services/api';
import {describeStatus} from './bookingStatus';
import {humanCreditMessage} from './creditErrors';
import type {Booking} from '../../types';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<BookingStackParamList>;
type Props = NativeStackScreenProps<BookingStackParamList, 'TripSummary'>;

function bookingSuffix(id: string): string {
  return id.replace(/-/g, '').slice(-12).toUpperCase();
}

function formatDateTime(iso: string | undefined | null): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  // UTC so the trip time matches the backend/ops value on every device.
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + 'Z';
}

function locationLabel(loc: {address?: string; latitude?: number; longitude?: number} | undefined): string {
  if (!loc) {return '—';}
  if (loc.address) {return loc.address;}
  if (loc.latitude !== undefined && loc.longitude !== undefined) {
    return `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;
  }
  return '—';
}

export default function TripSummaryScreen() {
  const insets     = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const route      = useRoute<Props['route']>();
  const {bookingId} = route.params;

  const {overlap} = useKeyboardLayout();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [team,    setTeam]    = useState<{cpos: AssignedCpoDto[]; vehicle: AssignedVehicleDto | null} | null>(null);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // B-379 — Step-11 escrow controls: null = legacy booking (no hold) → no card.
  const [escrow, setEscrow] = useState<null | {
    status: string; gross_credits: number; release_eligible_at: string | null; review_required: boolean;
  }>(null);
  // Distinguish "legacy booking, no hold" (404 → no card, correct) from a
  // transport failure (→ offer a retry). Both used to render the green
  // "payouts settled" banner while money sat on hold.
  const [escrowUnavailable, setEscrowUnavailable] = useState(false);
  const [escrowBusy, setEscrowBusy] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeCategory, setDisputeCategory] = useState<null | 'not_performed' | 'left_early' | 'wrong_guard' | 'conduct' | 'billing'>(null);
  const [disputeReason, setDisputeReason] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      try {
        const [bRes, tRes, eRes] = await Promise.all([
          bookingApi.getById(bookingId),
          assignmentApi.getTeam(bookingId).catch(() => ({data: null} as const)),
          bookingApi.getEscrow(bookingId).catch((e: unknown) => {
            const st = (e as {response?: {status?: number}})?.response?.status;
            // 404 = no hold (legacy booking). Anything else = we don't know.
            return {data: null, failed: st !== 404} as const;
          }),
        ]);
        if (cancelled) {return;}
        setBooking(bRes.data);
        setTeam(tRes.data ?? null);
        setEscrow(eRes.data ?? null);
        setEscrowUnavailable('failed' in eRes ? eRes.failed : false);
      } catch (e) {
        if (!cancelled) {setErr((e as Error).message);}
      } finally {
        if (!cancelled) {setLoading(false);}
      }
    })();
    return () => { cancelled = true; };
  }, [bookingId, reloadKey]);

  // B-380 rule applies here too: never let a raw server code reach an Alert.
  const escrowErrorCopy = (e: unknown, fallback: string): string => {
    const raw = (e as {response?: {data?: {message?: string | string[]}}})?.response?.data?.message;
    const text = Array.isArray(raw) ? raw.join(' ') : raw ?? (e as Error).message ?? '';
    return humanCreditMessage(text) ?? (text && !/^[a-z0-9_]+$/.test(text) ? text : fallback);
  };

  const confirmRelease = () => {
    if (escrowBusy) {return;}   // guard BEFORE the dialog — a double-tap stacks two otherwise
    Alert.alert('Release payment now?',
      'This releases the held payment to your protection agency immediately. Only confirm once you are fully satisfied with the mission.',
      [{text: 'Cancel', style: 'cancel'},
       {text: 'Release', onPress: () => {
         setEscrowBusy(true);
         bookingApi.confirmComplete(bookingId)
           .then(() => setReloadKey(k => k + 1))
           .catch((e: unknown) => {
             Alert.alert('Could not release', escrowErrorCopy(e, 'Please try again.'));
             setReloadKey(k => k + 1);   // re-read the truth — the sweep may have won
           })
           .finally(() => setEscrowBusy(false));
       }}]);
  };

  const submitDispute = () => {
    if (!disputeCategory || escrowBusy) {return;}
    setEscrowBusy(true);
    bookingApi.openDispute(bookingId, disputeCategory, disputeReason)
      .then(() => {
        setDisputeOpen(false);
        Alert.alert('Dispute opened', 'The payment is frozen while the Bravo Control System reviews your report.');
        setReloadKey(k => k + 1);
      })
      .catch((e: unknown) => {
        Alert.alert('Could not open dispute', escrowErrorCopy(e, 'Please try again.'));
        setReloadKey(k => k + 1);
      })
      .finally(() => setEscrowBusy(false));
  };

  const display = describeStatus(booking?.status);
  const isCompleted = (booking?.status ?? '').toUpperCase() === 'COMPLETED';
  const isCancelled = (booking?.status ?? '').toUpperCase() === 'CANCELLED';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />

      <View style={s.header}>
        <TouchableOpacity
          onPress={() => goBackOnce(navigation)}
          style={s.back}
          activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <Icon name="chevron-left" size={20} color={UI.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Trip Summary</Text>
        <View style={{width: 32}} />
      </View>

      {loading ? (
        <View style={s.center}>
          <LoadingView label="Loading trip summary…" />
        </View>
      ) : err ? (
        <View style={s.center}>
          <Icon name="alert-circle-outline" size={28} color="#F87171" />
          <Text style={s.errText}>{err}</Text>
          <TouchableOpacity
            style={s.retryBtn}
            activeOpacity={0.85}
            onPress={() => setReloadKey(k => k + 1)}
            accessibilityRole="button"
            accessibilityLabel="Retry loading trip summary">
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !booking ? (
        <View style={s.center}>
          <Text style={s.errText}>Booking not found.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[s.scroll, {paddingBottom: insets.bottom + 32 + overlap}]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">

          {/* Hero — booking suffix + status */}
          <View style={s.hero}>
      <ImageryBackdrop source={Imagery.svcExecTransport} variant="hero" radius={14} />
            <View style={s.heroBadge}>
              <Icon
                name={isCompleted ? 'check-decagram' : isCancelled ? 'close-octagon' : 'shield'}
                size={26}
                color={display.color}
              />
            </View>
            <Text style={s.heroRef}>BL-{bookingSuffix(booking.id)}</Text>
            <View style={[s.statusChip, {borderColor: display.color + '60', backgroundColor: display.color + '14'}]}>
              <Text style={[s.statusChipText, {color: display.color}]}>{display.label}</Text>
            </View>
            <Text style={s.heroSub}>
              {booking.type?.toString().replace(/_/g, ' ')} · {(booking as Booking & {region?: string}).region ?? '—'}
            </Text>
          </View>

          {/* Route */}
          <Section title="ROUTE">
            <Row k="Pickup"  v={locationLabel(booking.pickup)} />
            <Row k="Dropoff" v={locationLabel(booking.dropoff ?? undefined)} />
            <Row k="Started" v={formatDateTime(booking.start_time)} />
            <Row k="Ended"   v={formatDateTime(booking.end_time ?? booking.created_at)} />
            <Row k="Duration"
                 v={booking.duration_hours !== undefined ? `${booking.duration_hours} hour${booking.duration_hours === 1 ? '' : 's'}` : '—'} />
          </Section>

          {/* Order */}
          <Section title="ORDER">
            <Row k="CPOs"      v={`${booking.cpo_count ?? 0}`} />
            <Row k="Vehicle"   v={(booking.vehicle_type ?? '—').toString()} />
            <Row k="Add-ons"
                 v={booking.add_ons && booking.add_ons.length > 0
                    ? booking.add_ons.join(' · ')
                    : 'None'} />
            <Row k="Payment"   v={(booking.payment_method ?? '—').toString().replace(/_/g, ' ')} />
            <Row k="Total"     v={`${(booking.total_eur ?? booking.total_price ?? 0).toLocaleString()} BC`} highlight />
          </Section>

          {/* Team */}
          {team && (team.cpos.length > 0 || team.vehicle) && (
            <Section title="ASSIGNED TEAM">
              {team.cpos.map(c => (
                <View key={c.call_sign} style={s.crewRow}>
                  <View style={s.crewAv}>
                    <Text style={s.crewAvText}>{c.call_sign?.slice(-2) ?? '?'}</Text>
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.crewName} numberOfLines={1}>{c.call_sign} · {c.display_name}</Text>
                    <Text style={s.crewSub}>{c.role ?? 'CP'}</Text>
                  </View>
                </View>
              ))}
              {team.vehicle && (
                <View style={s.crewRow}>
                  <View style={[s.crewAv, {backgroundColor: 'rgba(91,141,239,0.18)'}]}>
                    <Icon name="car" size={14} color={UI.accent} />
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.crewName} numberOfLines={1}>{team.vehicle.call_sign} · {team.vehicle.make_model}</Text>
                    <Text style={s.crewSub}>
                      {team.vehicle.armored ? `Armored · ${team.vehicle.armor_grade ?? 'B-grade'}` : 'Soft-skin'}
                      {' · '}{team.vehicle.plate}
                    </Text>
                  </View>
                </View>
              )}
            </Section>
          )}

          {/* Notes */}
          {booking.notes && (
            <Section title="NOTES">
              <Text style={s.notes}>{booking.notes}</Text>
            </Section>
          )}

          {/* B-379 — Step-11 escrow controls: while the hold is PENDING_RELEASE the
              client can release early or freeze it with a dispute (previously the
              sweep timer was the only party moving this money). */}
          {isCompleted && escrow?.status === 'PENDING_RELEASE' && (
            <View style={s.escrowCard}>
              <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
                <Icon name="shield-lock-outline" size={16} color="#F5C76B" />
                <Text style={s.escrowTitle}>
                  {escrow.review_required ? 'PAYMENT UNDER REVIEW' : 'PAYMENT ON HOLD'}
                </Text>
              </View>
              {/* review_required (a failed proof-of-completion) blocks the release
                  server-side — promising an automatic payout there would be a lie. */}
              <Text style={s.escrowCopy}>
                {escrow.review_required
                  ? `${escrow.gross_credits.toLocaleString()} BC is held while the Bravo Control System reviews this mission. You’ll be notified once it settles — you can still report a problem below.`
                  : `${escrow.gross_credits.toLocaleString()} BC is held in escrow and releases to your agency automatically${escrow.release_eligible_at ? ` after ${formatDateTime(escrow.release_eligible_at)}` : ' shortly'}. Confirm to release it now, or report a problem to freeze it for review.`}
              </Text>
              {!escrow.review_required && (
                <TouchableOpacity
                  style={[s.escrowBtn, escrowBusy && {opacity: 0.6}]}
                  disabled={escrowBusy}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Confirm and release payment"
                  onPress={confirmRelease}>
                  {escrowBusy && !disputeOpen ? <ActivityIndicator color="#0B0E14" /> : (
                    <>
                      <Icon name="check-circle-outline" size={16} color="#0B0E14" />
                      <Text style={s.escrowBtnText}>CONFIRM & RELEASE</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={s.escrowLink}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Report a problem with this mission"
                accessibilityState={{expanded: disputeOpen}}
                onPress={() => setDisputeOpen(v => !v)}>
                <Icon name="flag-outline" size={14} color="#F87171" />
                <Text style={s.escrowLinkText}>{disputeOpen ? 'Hide report' : 'Report a problem'}</Text>
              </TouchableOpacity>
              {disputeOpen && (
                <View style={{gap: 10}}>
                  <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: 8}}>
                    {([
                      ['not_performed', 'Not performed'],
                      ['left_early', 'Left early'],
                      ['wrong_guard', 'Wrong guard'],
                      ['conduct', 'Conduct'],
                      ['billing', 'Billing'],
                    ] as const).map(([key, label]) => (
                      <TouchableOpacity
                        key={key}
                        style={[s.catChip, disputeCategory === key && s.catChipOn]}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityState={{selected: disputeCategory === key}}
                        onPress={() => setDisputeCategory(key)}>
                        <Text style={[s.catChipText, disputeCategory === key && {color: '#F2F4F8'}]}>{label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput
                    style={s.disputeInput}
                    value={disputeReason}
                    onChangeText={setDisputeReason}
                    placeholder="Describe what went wrong (optional)…"
                    placeholderTextColor="rgba(180,188,204,0.4)"
                    accessibilityLabel="What went wrong (optional)"
                    multiline
                    maxLength={1024}
                  />
                  <TouchableOpacity
                    style={[s.disputeSubmit, (!disputeCategory || escrowBusy) && {opacity: 0.5}]}
                    disabled={!disputeCategory || escrowBusy}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel="Submit dispute"
                    onPress={submitDispute}>
                    {escrowBusy ? <ActivityIndicator color="#F87171" /> : (
                      <Text style={s.disputeSubmitText}>SUBMIT DISPUTE — FREEZE PAYMENT</Text>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
          {isCompleted && escrow?.status === 'DISPUTED' && (
            <View style={[s.outcome, {borderColor: '#F5C76B60', backgroundColor: 'rgba(245,199,107,0.06)'}]}>
              <Icon name="scale-balance" size={18} color="#F5C76B" />
              <Text style={[s.outcomeText, {color: '#F5C76B'}]}>
                Dispute open — the payment is frozen while the Bravo Control System reviews it.
              </Text>
            </View>
          )}

          {/* Escrow state unknown (transport failure, not a legacy 404) — never
              claim "payouts settled" while money may be sitting on hold. */}
          {isCompleted && escrowUnavailable && (
            <TouchableOpacity
              style={s.escrowRetry}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Retry loading payment status"
              onPress={() => setReloadKey(k => k + 1)}>
              <Icon name="refresh" size={15} color="#F5C76B" />
              <Text style={s.escrowRetryText}>Payment status unavailable — tap to retry</Text>
            </TouchableOpacity>
          )}

          {/* Outcome banner */}
          {isCompleted && !escrowUnavailable && escrow?.status !== 'PENDING_RELEASE' && escrow?.status !== 'DISPUTED' && (
            <View style={[s.outcome, {borderColor: '#4ADE8060', backgroundColor: 'rgba(74,222,128,0.06)'}]}>
              <Icon name="check-decagram" size={18} color="#4ADE80" />
              <Text style={[s.outcomeText, {color: '#4ADE80'}]}>
                Mission delivered. Payouts settled. Group chat dissolved.
              </Text>
            </View>
          )}

          {/* Step 24 — rate the agency (idempotent server-side; safe to re-open) */}
          {isCompleted && (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => navigation.navigate('RateAgency', {bookingId: booking.id})}
              style={s.rateBtn}>
              <Icon name="star-outline" size={18} color="#0B0E14" />
              <Text style={s.rateBtnText} numberOfLines={1}>Rate the agency</Text>
            </TouchableOpacity>
          )}
          {/* F1 — the numbered receipt (or credit note for a refunded terminal). */}
          {(isCompleted || isCancelled) && (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => navigation.navigate('Invoice', {bookingId: booking.id})}
              style={[s.rateBtn, {backgroundColor: 'rgba(91,141,239,0.12)'}]}>
              <Icon name="file-document-outline" size={18} color="#A9C5FF" />
              <Text style={[s.rateBtnText, {color: '#A9C5FF'}]} numberOfLines={1}>
                {isCompleted ? 'View invoice' : 'View credit note'}
              </Text>
            </TouchableOpacity>
          )}
          {isCancelled && (
            <View style={[s.outcome, {borderColor: '#F8717160', backgroundColor: 'rgba(248,113,113,0.06)'}]}>
              <Icon name="close-octagon" size={18} color="#F87171" />
              <Text style={[s.outcomeText, {color: '#F87171'}]}>
                Booking cancelled. Any escrowed credits were refunded.
              </Text>
            </View>
          )}

          <View style={{height: 24}} />
        </ScrollView>
      )}
    </View>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.card}>{children}</View>
    </View>
  );
}

function Row({k, v, highlight}: {k: string; v: string; highlight?: boolean}) {
  return (
    <View style={s.row}>
      <Text style={s.rowK}>{k}</Text>
      <Text style={[s.rowV, highlight && s.rowVHighlight]} numberOfLines={2}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
  },
  back: {
    width: 32, height: 32, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)',
  },
  headerTitle: {
    fontSize: 14, fontWeight: '700', letterSpacing: 1.2,
    color: UI.text,
  },

  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 32},
  errText: {color: '#F87171', fontSize: 12, textAlign: 'center'},
  retryBtn: {
    paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999, marginTop: 4,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)',
  },
  retryText: {fontSize: 12.5, fontWeight: '700', color: UI.accentSoft},

  scroll: {padding: 14, paddingBottom: 32, gap: 12},

  hero: {
    alignItems: 'center', padding: 20, borderRadius: 14,
    backgroundColor: 'rgba(91,141,239,0.06)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.18)',
  },
  heroBadge: {
    width: 56, height: 56, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)',
    marginBottom: 12,
  },
  heroRef: {
    fontFamily: 'JetBrains Mono', fontSize: 17, fontWeight: '800',
    color: UI.text, letterSpacing: 1.2,
  },
  heroSub: {
    fontSize: 11, color: UI.textDim, marginTop: 6,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },

  statusChip: {
    marginTop: 10, paddingHorizontal: 12, paddingVertical: 4,
    borderRadius: 999, borderWidth: 1,
  },
  statusChipText: {
    fontSize: 10, fontWeight: '800', letterSpacing: 1.4,
  },

  section: {gap: 6},
  sectionTitle: {
    fontSize: 10, fontWeight: '800', letterSpacing: 1.5,
    color: UI.textDim,
  },
  card: {
    borderRadius: 12, backgroundColor: UI.surface,
    borderWidth: 1, borderColor: UI.hair,
    padding: 4,
  },

  row: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 9, paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: UI.hair,
    gap: 12,
  },
  rowK: {
    fontSize: 10, color: UI.textDim,
    letterSpacing: 1.1, textTransform: 'uppercase', fontWeight: '700',
    flexShrink: 1, minWidth: 0,
  },
  rowV: {
    fontSize: 12, color: UI.text, fontWeight: '600',
    flex: 1, textAlign: 'right',
  },
  rowVHighlight: {color: UI.accent, fontSize: 14, fontWeight: '800'},

  crewRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: UI.hair,
  },
  crewAv: {
    width: 32, height: 32, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.18)',
  },
  crewAvText: {
    color: UI.text, fontWeight: '800', fontSize: 11, letterSpacing: 0.5,
  },
  crewName: {fontSize: 12, fontWeight: '700', color: UI.text},
  crewSub:  {fontSize: 10, color: UI.textDim, marginTop: 2},

  notes: {fontSize: 12, color: UI.text, padding: 10, lineHeight: 17},

  // B-379 — escrow controls card
  escrowCard: {
    borderRadius: 14, padding: 14, gap: 11,
    backgroundColor: 'rgba(245,199,107,0.05)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.3)',
  },
  escrowTitle: {fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: '#F5C76B'},
  escrowCopy: {fontSize: 12, lineHeight: 17.5, color: UI.textDim ?? 'rgba(229,233,242,0.62)'},
  escrowBtn: {
    flexDirection: 'row', gap: 8, minHeight: 46, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#4ADE80',
  },
  escrowBtnText: {fontSize: 13, fontWeight: '800', letterSpacing: 0.5, color: '#0B0E14'},
  escrowLink: {flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', paddingVertical: 4},
  escrowLinkText: {fontSize: 12.5, fontWeight: '700', color: '#F87171'},
  catChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
  },
  catChipOn: {backgroundColor: 'rgba(248,113,113,0.12)', borderColor: 'rgba(248,113,113,0.45)'},
  catChipText: {fontSize: 11.5, fontWeight: '700', color: 'rgba(180,188,204,0.7)'},
  disputeInput: {
    minHeight: 68, borderRadius: 12, padding: 12,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
    fontSize: 12.5, lineHeight: 18, color: UI.text, textAlignVertical: 'top',
  },
  disputeSubmit: {
    minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: 'rgba(248,113,113,0.08)', borderWidth: 1, borderColor: 'rgba(248,113,113,0.4)',
  },
  disputeSubmitText: {fontSize: 12, fontWeight: '800', letterSpacing: 0.6, color: '#F87171', textAlign: 'center'},
  escrowRetry: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14,
    backgroundColor: 'rgba(245,199,107,0.05)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.3)',
  },
  escrowRetryText: {fontSize: 12, fontWeight: '700', color: '#F5C76B'},

  outcome: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: 10, borderWidth: 1,
  },
  outcomeText: {flex: 1, fontSize: 11.5, fontWeight: '700', lineHeight: 16},
  rateBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    minHeight: 50, borderRadius: 14, backgroundColor: '#F5C76B', marginTop: 4,
  },
  rateBtnText: {fontSize: 14.5, fontWeight: '700', color: '#0B0E14'},
}));
