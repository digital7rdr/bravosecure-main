/**
 * RateAgencyScreen (BUILD_RUNBOOK Step 24) — the client rates the agency that ran a
 * COMPLETED booking. Stars (required) + optional quick tags → POST /bookings/:id/rating,
 * which recomputes agents.rating (the dispatch-ranking trust signal). Idempotent server-
 * side: re-submitting is a no-op, so a double-tap or re-entry can't skew the average.
 * Obsidian/cobalt to match the rest of the dispatch path.
 */
import React, {useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar, ActivityIndicator, ScrollView, TextInput} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {bookingApi} from '@services/api';
import RatingStars from '@components/ui/RatingStars';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'RateAgency'>;
type Rt = RouteProp<BookingStackParamList, 'RateAgency'>;

const TAGS = ['Professional', 'On time', 'Felt safe', 'Discreet', 'Great comms', 'Would rebook'];
// Issue 31 — mirrors SubmitRatingDto's @MaxLength(500) and the column CHECK,
// so the field can never submit something the server will reject.
const REMARKS_MAX = 500;

export default function RateAgencyScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {bookingId} = useRoute<Rt>().params;
  const [stars, setStars] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [remarks, setRemarks] = useState('');
  // B-184 — the bottom-most element owns the keyboard inset. bottomPad REPLACES
  // the safe-area inset while the IME is up; it never stacks on it.
  const {bottomPad} = useKeyboardLayout();
  const [submitting, setSubmitting] = useState(false);

  const toggleTag = (t: string) =>
    setTags(cur => (cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t]));

  const submit = async () => {
    if (stars < 1 || submitting) {return;}
    setSubmitting(true);
    try {
      await bookingApi.submitRating(bookingId, {stars, tags, remarks: remarks.trim() || undefined});
      navigation.goBack();
    } catch (e) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Could not submit rating', msg ?? 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}} accessibilityRole="button" accessibilityLabel="Go back">
          <Icon name="chevron-left" size={20} color={UI.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Rate the agency</Text>
      </View>

      <ScrollView style={{flex: 1}} contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        <Text style={s.lead}>How was your detail?</Text>
        <Text style={s.sub}>Your rating helps the best firms reach more clients.</Text>

        <View style={s.starsWrap}>
          <RatingStars value={stars} onChange={setStars} size={44} />
        </View>

        <View style={s.tagWrap}>
          {TAGS.map(t => {
            const on = tags.includes(t);
            return (
              <TouchableOpacity key={t} onPress={() => toggleTag(t)} activeOpacity={0.8}
                accessibilityRole="button" accessibilityState={{selected: on}}
                hitSlop={{top: 6, bottom: 6, left: 0, right: 0}}
                style={[s.tag, on && s.tagOn]}>
                <Text style={[s.tagText, on && s.tagTextOn]}>{t}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {/* Issue 31 — optional free text beneath the preset tags. Private to
            authorised quality/ops roles; never shown back to the provider. */}
        <View style={s.remarksWrap}>
          <Text style={s.remarksLabel}>Anything else? (optional)</Text>
          <TextInput
            style={s.remarksInput}
            value={remarks}
            onChangeText={setRemarks}
            placeholder="Tell us more about the service…"
            placeholderTextColor={UI.textMute}
            multiline
            maxLength={REMARKS_MAX}
            textAlignVertical="top"
            accessibilityLabel="Written remarks about this detail"
          />
          <Text style={s.remarksCount}>{remarks.length}/{REMARKS_MAX}</Text>
          <Text style={s.remarksNote}>Shared only with the Bravo quality team.</Text>
        </View>
      </ScrollView>

      <View style={[s.footer, {paddingBottom: bottomPad(12)}]}>
        <TouchableOpacity activeOpacity={stars < 1 || submitting ? 1 : 0.9} onPress={() => { void submit(); }}
          disabled={stars < 1 || submitting} style={[s.cta, (stars < 1 || submitting) && s.ctaDisabled]}>
          {submitting
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.ctaText}>Submit rating</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => goBackOnce(navigation)} activeOpacity={0.7} style={s.skip}>
          <Text style={s.skipText}>Not now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12},
  back: {width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: UI.surface},
  headerTitle: {fontFamily: UI.fSemi, fontSize: 16, color: UI.text},
  body: {flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, alignItems: 'center'},
  lead: {fontFamily: UI.fBold, fontSize: 22, color: UI.text, textAlign: 'center'},
  sub: {fontFamily: UI.fSans, fontSize: 13, color: UI.textDim, textAlign: 'center', marginTop: 8, lineHeight: 19},
  starsWrap: {marginTop: 32, marginBottom: 28},
  tagWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center'},
  tag: {paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: UI.hair, backgroundColor: UI.surface},
  tagOn: {borderColor: 'rgba(91,141,239,0.5)', backgroundColor: 'rgba(91,141,239,0.12)'},
  tagText: {fontFamily: UI.fSans, fontSize: 13, color: UI.textDim},
  tagTextOn: {color: UI.accentSoft, fontFamily: UI.fSemi},
  remarksWrap: {marginTop: 26, gap: 6},
  remarksLabel: {fontFamily: UI.fSemi, fontSize: 12.5, color: UI.textDim},
  remarksInput: {
    minHeight: 96, borderRadius: 12, borderWidth: 1, borderColor: UI.hair,
    backgroundColor: UI.surface, paddingHorizontal: 12, paddingVertical: 10,
    fontFamily: UI.fSans, fontSize: 14, color: UI.text,
  },
  remarksCount: {fontFamily: UI.fSans, fontSize: 11, color: UI.textMute, textAlign: 'right'},
  remarksNote: {fontFamily: UI.fSans, fontSize: 11, color: UI.textMute},
  footer: {paddingHorizontal: 24, paddingTop: 16},
  cta: {height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: UI.accent},
  ctaDisabled: {backgroundColor: '#1C2436'},
  ctaText: {fontFamily: UI.fBold, fontSize: 16, color: '#fff', letterSpacing: 0.3},
  skip: {alignItems: 'center', paddingVertical: 14},
  skipText: {fontFamily: UI.fSemi, fontSize: 14, color: UI.textMute},
}));
