/**
 * The FAMILY MEMBER's own spending view — spec §41, §42.
 *
 * Renders nothing for a user who is not an active family member, so it is safe
 * to mount unconditionally on a profile screen.
 *
 * Two rules this component exists to obey:
 *
 *  · §41 — the primary value for the member is THEIR OWN remaining quota. The
 *    holder's raw balance is never shown; the server sends `effectiveSpendable`
 *    (`min(remaining quota, root credit)`) so a member can understand a refusal
 *    without being handed the holder's finances.
 *
 *  · §42/§12 — when the quota is spent, offer "Request More Credit" ONCE. If a
 *    request is already open the button becomes a status line, because a second
 *    button would create a duplicate the server is going to refuse anyway.
 *
 * Every number here comes from the server on each focus (§46/§47/§48): this
 * card is a display of server state, never an authority on it, and it is
 * refetched rather than reasoned about after any failed action.
 */
import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Alert} from '@utils/alert';
import {familyApi, type FamilyMembership} from '@services/api';
import {pendingCreditRequestFrom} from '@screens/booking/creditErrors';

const T = {
  text:      '#F2F4F8',
  textDim:   'rgba(229,233,242,0.62)',
  textMute:  'rgba(180,188,204,0.45)',
  hair:      'rgba(255,255,255,0.06)',
  hair2:     'rgba(255,255,255,0.09)',
  accent:    '#5B8DEF',
  accentDeep:'#2F5BE0',
  accentSoft:'#A9C5FF',
  signal:    '#4ADE80',
  amber:     '#F5C76B',
  alert:     '#FF8585',
  card:      'rgba(18,22,30,0.85)',
} as const;

/** Usage bands mirror the server's warning thresholds (§34) so the bar colour
 *  and the notification the holder receives can never disagree. */
function barColor(pct: number): string {
  if (pct >= 100) {return T.alert;}
  if (pct >= 90)  {return T.amber;}
  if (pct >= 80)  {return T.amber;}
  return T.accent;
}

export function FamilyQuotaCard() {
  const [membership, setMembership] = useState<FamilyMembership | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [amountText, setAmountText] = useState('');

  const load = useCallback(async () => {
    try {
      const {data} = await familyApi.membership();
      setMembership(data.membership);
    } catch {
      // Keep the last good view rather than flashing an error card: a transient
      // network failure does not mean the member lost their quota.
    } finally {
      setLoading(false);
    }
  }, []);

  // §47 — the same member may be spending on another device, so re-read on
  // every focus rather than trusting what this screen last drew.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const submitRequest = async () => {
    const parsed = parseInt(amountText.trim(), 10);
    // §30 — a client-side gate for the obvious cases only; the server validates
    // independently and is the authority.
    if (!Number.isFinite(parsed) || parsed <= 0) {
      Alert.alert('Enter an amount', 'How many more credits do you need?');
      return;
    }
    setBusy(true);
    try {
      await familyApi.requestCredit(parsed);
      setAsking(false);
      setAmountText('');
      Alert.alert('Request sent', 'Your plan holder will be notified.');
      await load();
    } catch (e) {
      // §12/§42 — a request is already open. Not a retryable failure: show the
      // truth and reconcile, never a second create attempt.
      const open = pendingCreditRequestFrom(e);
      if (open) {
        setAsking(false);
        Alert.alert('Request already pending', 'You already have a credit request awaiting approval.');
        await load();
      } else {
        Alert.alert('Could not send request', 'Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelRequest = async (id: string) => {
    setBusy(true);
    try {
      await familyApi.cancelCredit(id);
      await load();
    } catch {
      Alert.alert('Could not cancel', 'Please try again.');
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={s.loading}><ActivityIndicator color={T.accent} /></View>
    );
  }
  // Not a family member — this whole surface does not apply.
  if (!membership) {return null;}

  const {spendLimit, spent, remaining, effectiveSpendable, rootSuspended, pendingRequest} = membership;
  const unlimited = spendLimit === null;
  // Guarded against a zero limit so the bar never divides by zero; a zero quota
  // is 100% used by definition, which matches the server's own band rule.
  const pct = unlimited ? 0
    : spendLimit === 0 ? 100
    : Math.min(100, Math.round((spent / spendLimit) * 100));
  const exhausted = !unlimited && (remaining ?? 0) <= 0;
  // §9 — the member's quota is fine but nothing is spendable, so the ROOT is the
  // problem. These must read differently; conflating them is the defect §9 names.
  const rootShort = !exhausted && effectiveSpendable <= 0;

  return (
    <View style={s.card}>
      <View style={s.headRow}>
        <Icon name="wallet-outline" size={16} color={T.accentSoft} />
        <Text style={s.head}>YOUR SPENDING LIMIT</Text>
      </View>
      <Text style={s.holder} numberOfLines={1}>
        On {membership.holderName}’s plan
      </Text>

      {unlimited ? (
        <Text style={s.unlimited}>No spending limit set</Text>
      ) : (
        <>
          {/* §41 — allocated / used / remaining, with remaining given the most
              weight: it is the number the member actually acts on. */}
          <View style={s.figures}>
            <Figure label="Limit" value={spendLimit} />
            <Figure label="Used" value={spent} />
            <Figure label="Remaining" value={remaining ?? 0} strong />
          </View>
          <View style={s.track}>
            <View style={[s.fill, {width: `${pct}%`, backgroundColor: barColor(pct)}]} />
          </View>
        </>
      )}

      {/* §21 — outranks everything else, and says nothing about their limit. */}
      {rootSuspended ? (
        <Text style={[s.notice, {color: T.alert}]}>
          Your plan holder’s account is suspended, so spending is paused.
        </Text>
      ) : rootShort ? (
        // §9 — do NOT tell them their own quota is exhausted; it isn't.
        <Text style={[s.notice, {color: T.amber}]}>
          The Root Account currently has insufficient credit. Your own limit is unaffected.
        </Text>
      ) : exhausted ? (
        <Text style={[s.notice, {color: T.amber}]}>
          You’ve reached your spending limit.
        </Text>
      ) : !unlimited && pct >= 80 ? (
        <Text style={[s.notice, {color: T.amber}]}>
          You’re approaching your spending limit.
        </Text>
      ) : null}

      {/* §42 — one action, and never a duplicate-creating one. */}
      {pendingRequest ? (
        <View style={s.pendingRow}>
          <Text style={s.pendingText} numberOfLines={2}>
            Request for {pendingRequest.requestedCredits.toLocaleString()} BC is pending approval.
          </Text>
          <TouchableOpacity
            style={[s.btn, s.btnGhost]}
            disabled={busy}
            onPress={() => { void cancelRequest(pendingRequest.id); }}
            accessibilityRole="button"
            accessibilityLabel="Cancel your pending credit request">
            <Text style={s.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : asking ? (
        <View style={s.askRow}>
          <TextInput
            style={s.input}
            value={amountText}
            onChangeText={setAmountText}
            placeholder="Amount (BC)"
            placeholderTextColor={T.textMute}
            keyboardType="number-pad"
            maxLength={7}
            accessibilityLabel="Additional credits requested"
          />
          <TouchableOpacity
            style={[s.btn, s.btnGhost]}
            disabled={busy}
            onPress={() => { setAsking(false); setAmountText(''); }}
            accessibilityRole="button"
            accessibilityLabel="Cancel request">
            <Text style={s.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, s.btnPrimary]}
            disabled={busy}
            onPress={() => { void submitRequest(); }}
            accessibilityRole="button"
            accessibilityLabel="Send credit request">
            <Text style={s.btnPrimaryText}>Send</Text>
          </TouchableOpacity>
        </View>
      ) : (
        // Offered whenever there is a limit to raise — approaching it is reason
        // enough to ask, and a member who has JUST been blocked should not have
        // to spend more to find the button. Not offered on an unlimited quota:
        // there is no ceiling to raise, and the server refuses that anyway.
        !unlimited && (
          <TouchableOpacity
            style={[s.btn, s.btnPrimary, s.btnWide]}
            disabled={busy}
            onPress={() => setAsking(true)}
            accessibilityRole="button"
            accessibilityLabel="Request more credit from your plan holder">
            <Icon name="plus-circle-outline" size={14} color="#FFF" />
            <Text style={s.btnPrimaryText}>Request More Credit</Text>
          </TouchableOpacity>
        )
      )}
    </View>
  );
}

function Figure({label, value, strong}: {label: string; value: number; strong?: boolean}) {
  return (
    <View style={{flex: 1, minWidth: 0}}>
      <Text style={s.figLabel}>{label}</Text>
      <Text style={[s.figValue, strong && s.figValueStrong]} numberOfLines={1}>
        {value.toLocaleString()}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  loading: {paddingVertical: 24, alignItems: 'center'},
  card: {
    padding: 16, borderRadius: 18, gap: 10,
    backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2,
  },
  headRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  head:    {color: T.textMute, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2},
  holder:  {color: T.textDim, fontSize: 12.5, fontWeight: '600'},

  figures: {flexDirection: 'row', gap: 12, marginTop: 2},
  figLabel: {color: T.textMute, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6},
  figValue: {color: T.textDim, fontSize: 16, fontWeight: '700', marginTop: 2},
  figValueStrong: {color: T.text, fontSize: 19, fontWeight: '800'},

  track: {height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden'},
  fill:  {height: '100%', borderRadius: 3},

  unlimited: {color: T.signal, fontSize: 13, fontWeight: '700'},
  notice:    {fontSize: 12.5, fontWeight: '600', lineHeight: 17},

  pendingRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  pendingText: {flex: 1, minWidth: 0, color: T.amber, fontSize: 12.5, fontWeight: '600'},

  askRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  input: {
    flex: 1, minWidth: 0, minHeight: 40, borderRadius: 10,
    paddingHorizontal: 12, color: T.text, fontSize: 13.5,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.hair2,
  },

  btn: {
    minHeight: 40, paddingHorizontal: 14, borderRadius: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
  },
  btnWide:        {alignSelf: 'stretch'},
  btnGhost:       {backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.hair2},
  btnGhostText:   {color: T.textDim, fontSize: 12.5, fontWeight: '700'},
  btnPrimary:     {backgroundColor: T.accentDeep},
  btnPrimaryText: {color: '#FFFFFF', fontSize: 12.5, fontWeight: '700'},
});
