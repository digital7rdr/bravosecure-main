import React, {useCallback, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {walletApi, type SavedCardDto} from '@services/api';
import {usePaymentFlow} from '@services/stripe';
import {BravoFont} from '@/theme/bravo';
import LoadingView from '@components/LoadingView';
import {goBackOnce} from '@navigation/tapGuard';

const T = {
  bg:       '#07090D',
  text:     '#F2F4F8',
  textDim:  'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)',
  hair:     'rgba(255,255,255,0.06)',
  hair2:    'rgba(255,255,255,0.09)',
  accent:   '#5B8DEF',
  accentDeep:'#2F5BE0',
  blue:     '#A9C5FF',
  signal:   '#4ADE80',
  alert:    '#FF8585',
  card:     'rgba(18,22,30,0.85)',
} as const;

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// W4/B-685 — exported through withPaymentBoundary (bottom of file): the Stripe
// provider mounts with THIS screen, not at the App root. See PaymentBoundary.tsx.
function PaymentMethodsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const {addCard} = usePaymentFlow();
  const [cards, setCards] = useState<SavedCardDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const {data} = await walletApi.listCards();
      setCards(data.cards);
    } catch { /* surfaced via empty state */ } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const onAdd = async () => {
    if (busy) {return;}
    setBusy(true);
    try {
      const ok = await addCard();
      if (ok) { await load(); }
    } catch (e) {
      Alert.alert('Could not add card', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onSetDefault = async (id: string) => {
    try { await walletApi.setDefaultCard(id); await load(); }
    catch { Alert.alert('Could not set default card'); }
  };

  const onDelete = (id: string) => {
    Alert.alert('Remove card', 'Remove this card from your account?', [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Remove', style: 'destructive', onPress: () => {
        void (async () => {
          try { await walletApi.removeCard(id); await load(); }
          catch { Alert.alert('Could not remove card'); }
        })();
      }},
    ]);
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={22} color={T.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Payment Methods</Text>
        <View style={{width: 36}} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>

        {loading ? (
          <View style={{paddingVertical: 56, alignItems: 'center'}}>
            <LoadingView compact label="Loading payment methods…" />
          </View>
        ) : cards.length === 0 ? (
          <View style={styles.emptyCard}>
      <ImageryBackdrop source={Imagery.creditsHero} variant="card" radius={18} />
            <Icon name="credit-card-off-outline" size={30} color={T.textMute} />
            <Text style={styles.emptyText}>No cards saved</Text>
            <Text style={styles.emptySub}>Add a card to pay for bookings and top-ups faster.</Text>
          </View>
        ) : (
          cards.map(c => (
            <View key={c.id} style={styles.card}>
              <View style={styles.cardIcon}>
                <Icon name="credit-card-outline" size={22} color={T.blue} />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={styles.cardBrand} numberOfLines={1}>{cap(c.brand)} ···· {c.last4}</Text>
                <Text style={styles.cardExp}>Expires {String(c.exp_month).padStart(2, '0')}/{c.exp_year}</Text>
              </View>
              {c.is_default ? (
                <View style={styles.defaultBadge}>
                  <Text style={styles.defaultText}>DEFAULT</Text>
                </View>
              ) : (
                <TouchableOpacity onPress={() => { void onSetDefault(c.id); }} activeOpacity={0.7}>
                  <Text style={styles.setDefault}>Set default</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.del} onPress={() => onDelete(c.id)} activeOpacity={0.7}>
                <Icon name="trash-can-outline" size={18} color={T.alert} />
              </TouchableOpacity>
            </View>
          ))
        )}

        <TouchableOpacity style={styles.addBtn} onPress={() => { void onAdd(); }} disabled={busy} activeOpacity={0.85}>
          {busy ? <ActivityIndicator color="#fff" /> : (
            <>
              <Icon name="plus" size={18} color="#fff" />
              <Text style={styles.addText}>Add Card</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={styles.secureRow}>
          <Icon name="lock" size={12} color={T.textMute} />
          <Text style={styles.secureText}>Cards are stored securely by Stripe — Bravo never sees your card number.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: T.bg},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10},
  back: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontFamily: BravoFont.bold, fontSize: 17, letterSpacing: -0.3, color: T.text},

  content: {paddingHorizontal: 20, paddingTop: 8, gap: 12},

  card: {flexDirection: 'row', alignItems: 'center', gap: 13, padding: 14, borderRadius: 16, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2},
  cardIcon: {width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.26)'},
  cardBrand: {fontFamily: BravoFont.bold, fontSize: 15, letterSpacing: 0.4, color: T.text},
  cardExp: {fontFamily: BravoFont.regular, fontSize: 11.5, color: T.textMute, marginTop: 3},
  defaultBadge: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, backgroundColor: 'rgba(74,222,128,0.1)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)'},
  defaultText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 0.8, color: T.signal},
  setDefault: {fontFamily: BravoFont.semiBold, fontSize: 11.5, color: T.blue},
  del: {width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.hair2},

  emptyCard: {alignItems: 'center', gap: 8, paddingVertical: 40, paddingHorizontal: 24, borderRadius: 18, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2},
  emptyText: {fontFamily: BravoFont.bold, fontSize: 15, color: T.text, marginTop: 4},
  emptySub: {fontFamily: BravoFont.regular, fontSize: 12.5, color: T.textMute, textAlign: 'center'},

  addBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 54, borderRadius: 16, marginTop: 4, backgroundColor: T.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  addText: {fontFamily: BravoFont.bold, fontSize: 15, color: '#fff'},

  secureRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 8, paddingHorizontal: 20},
  secureText: {flex: 1, fontFamily: BravoFont.regular, fontSize: 11, color: T.textMute, lineHeight: 16},
});

import {withPaymentBoundary} from '@components/PaymentBoundary';
export default withPaymentBoundary(PaymentMethodsScreen);
