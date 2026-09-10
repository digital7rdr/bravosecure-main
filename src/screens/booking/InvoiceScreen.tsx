/**
 * InvoiceScreen (F1) — the numbered, line-itemised receipt behind the previously
 * dead INVOICE button. Renders the server-issued invoice (client_receipt for a
 * COMPLETED detail, credit_note for a refunded terminal): line items, tax
 * break-out, total, booking context. Native render; a PDF export can later ride
 * the same invoice row. Obsidian + cobalt, matching the booking flow.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {BookingStackParamList} from '@navigation/types';
import {bookingApi, type InvoiceDto} from '@services/api';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'});
}

export default function InvoiceScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {bookingId} = useRoute<RouteProp<BookingStackParamList, 'Invoice'>>().params;
  const [invoice, setInvoice] = useState<InvoiceDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const {data} = await bookingApi.getInvoice(bookingId);
      setInvoice(data);
    } catch (e: unknown) {
      const raw = (e as {response?: {data?: {message?: string | string[]}}})?.response?.data?.message;
      const code = Array.isArray(raw) ? raw[0] : raw;
      setError(code === 'invoice_not_available_yet'
        ? 'Your invoice is issued once the detail completes.'
        : (typeof code === 'string' ? code : (e as Error).message) ?? 'Could not load the invoice.');
    }
  }, [bookingId]);

  useEffect(() => { void load(); }, [load]);

  const isCredit = invoice?.kind === 'credit_note';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={UI.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.headerTitle}>{isCredit ? 'Credit Note' : 'Invoice'}</Text>
          <Text style={s.headerSub} numberOfLines={1} ellipsizeMode="tail">{invoice?.invoice_number ?? '—'}</Text>
        </View>
      </View>

      {!invoice && !error ? (
        <View style={s.center}><LoadingView label="Loading invoice…" /></View>
      ) : error ? (
        <View style={s.center}>
          <Icon name="file-alert-outline" size={30} color={UI.textMute} importantForAccessibility="no" />
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity style={s.retryBtn} activeOpacity={0.85} onPress={() => void load()}
            accessibilityRole="button" accessibilityLabel="Retry loading invoice" hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : invoice ? (
        <ScrollView contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 28, gap: 14}}
          showsVerticalScrollIndicator={false}>
          {/* Issuer strip */}
          <View style={s.card}>
            <View style={s.rowBetween}>
              <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
                <Icon name="shield-check" size={16} color={UI.accentSoft} importantForAccessibility="no" />
                <Text style={s.brand}>BRAVO SECURE</Text>
              </View>
              <Text style={s.issued}>{fmtDate(invoice.issued_at)}</Text>
            </View>
            <Text style={s.meta}>{invoice.booking.service === 'executive_protection' ? 'Executive Protection' : invoice.booking.service.replace(/_/g, ' ')} · {invoice.booking.region_label}</Text>
            <Text style={s.meta}>{invoice.booking.cpo_count} CPO · {invoice.booking.duration_hours}h · {fmtDate(invoice.booking.pickup_time)}</Text>
            <Text style={s.metaDim} numberOfLines={2}>{invoice.booking.pickup_address}
              {invoice.booking.dropoff_address ? ` → ${invoice.booking.dropoff_address}` : ''}</Text>
          </View>

          {/* Line items */}
          <View style={s.card}>
            <Text style={s.cardLabel}>{isCredit ? 'REFUND' : 'CHARGES'}</Text>
            {invoice.line_items.map((l, i) => (
              <View key={`${l.label}-${i}`} style={s.lineRow}>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.lineLabel} numberOfLines={2}>{l.label}</Text>
                  {l.per_hour !== null && l.hours !== null ? (
                    <Text style={s.lineSub}>{l.per_hour.toLocaleString()} BC/h × {l.hours}h</Text>
                  ) : null}
                </View>
                <Text style={s.lineAmt}>{l.amount_credits.toLocaleString()} BC</Text>
              </View>
            ))}
            <View style={s.divider} />
            <View style={s.lineRow}>
              <Text style={s.totLabel}>Subtotal</Text>
              <Text style={s.totVal}>{invoice.subtotal_credits.toLocaleString()} BC</Text>
            </View>
            {invoice.tax_credits !== 0 ? (
              <View style={s.lineRow}>
                <Text style={s.totLabel}>Tax ({invoice.tax_rate_pct}%, included)</Text>
                <Text style={s.totVal}>{invoice.tax_credits.toLocaleString()} BC</Text>
              </View>
            ) : null}
            <View style={s.lineRow}>
              <Text style={s.grandLabel}>{isCredit ? 'Refunded' : 'Total paid'}</Text>
              <Text style={[s.grandVal, isCredit && {color: UI.signal}]}>
                {Math.abs(invoice.total_credits).toLocaleString()} BC
              </Text>
            </View>
          </View>

          <Text style={s.footnote}>
            Amounts are in Bravo Credits. Payment moved through the Bravo escrow at
            acceptance; this document reflects the settled amounts.
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14},
  back: {width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: UI.hair},
  headerTitle: {fontFamily: UI.fBold, fontSize: 18, color: UI.text, letterSpacing: -0.2},
  headerSub: {fontFamily: UI.fSemi, fontSize: 11, letterSpacing: 1, color: UI.textMute, marginTop: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 40},
  errorText: {fontFamily: UI.fSans, fontSize: 13.5, color: UI.textDim, textAlign: 'center', lineHeight: 20},
  retryBtn: {paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)'},
  retryText: {fontFamily: UI.fBold, fontSize: 12.5, color: UI.accentSoft},
  card: {borderRadius: 16, padding: 16, gap: 8, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: UI.hair},
  rowBetween: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  brand: {fontFamily: UI.fBold, fontSize: 12, letterSpacing: 1.6, color: UI.text},
  issued: {fontFamily: UI.fSemi, fontSize: 11, color: UI.textMute},
  meta: {fontFamily: UI.fSemi, fontSize: 12.5, color: UI.textDim},
  metaDim: {fontFamily: UI.fSans, fontSize: 11.5, color: UI.textMute, lineHeight: 16},
  cardLabel: {fontFamily: UI.fSemi, fontSize: 10, letterSpacing: 1.5, color: UI.textMute, marginBottom: 2},
  lineRow: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingVertical: 4},
  lineLabel: {fontFamily: UI.fSans, fontSize: 13, color: UI.text, lineHeight: 18},
  lineSub: {fontFamily: UI.fSans, fontSize: 11, color: UI.textMute, marginTop: 1},
  lineAmt: {fontFamily: UI.fSemi, fontSize: 13, color: UI.text},
  divider: {height: 1, backgroundColor: UI.hair, marginVertical: 6},
  totLabel: {fontFamily: UI.fSans, fontSize: 12.5, color: UI.textDim},
  totVal: {fontFamily: UI.fSemi, fontSize: 12.5, color: UI.textDim},
  grandLabel: {fontFamily: UI.fBold, fontSize: 14.5, color: UI.text},
  grandVal: {fontFamily: UI.fBold, fontSize: 16, color: UI.accentSoft},
  footnote: {fontFamily: UI.fSans, fontSize: 11, color: UI.textMute, lineHeight: 16, textAlign: 'center', paddingHorizontal: 10},
}));
