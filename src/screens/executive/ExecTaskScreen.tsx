/**
 * Executive Protection · Step 04 — Task Details
 *
 * Receives the service-location pick back from LocationPicker (merge-param
 * contract, same as BookingDateTime), shows it as an editable row, then asks
 * WHAT the protection is for: task-type select (accordion) + an optional
 * 0/500 brief that rides the booking `notes` field.
 *
 * Keyboard: the brief is a TextInput, so the screen is built on
 * KeyboardAvoidingScreen (B-184) — the footer CTA stays above the IME.
 */
import React, {useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar, TextInput} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore} from '@store/bookingStore';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {EXEC_TASK_TYPES, execTaskLabel} from './executiveProduct';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ExecTask'>;
type Rt  = RouteProp<BookingStackParamList, 'ExecTask'>;

const NOTES_MAX = 500;

// Design tokens — obsidian/cobalt premium (mirrors the executive/Lite wizard).
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

export default function ExecTaskScreen() {
  const insets = useSafeAreaInsets();
  const {safeBottom} = useKeyboardLayout();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const updateDraft = useBookingStore(st => st.updateDraft);
  const draft = useBookingStore(st => st.draft);

  const [typeOpen, setTypeOpen] = useState(false);

  // ── Drain the LocationPicker's merge-params into the draft ──
  useEffect(() => {
    const p = route.params;
    if (!p?.pickedAt || typeof p.pickedLat !== 'number' || typeof p.pickedLng !== 'number') {return;}
    if (p.pickedKind === 'pickup') {
      updateDraft({
        pickup: {
          address: p.pickedAddress ?? 'Selected location',
          latitude: p.pickedLat,
          longitude: p.pickedLng,
          label: 'Service location',
        },
      });
    }
    navigation.setParams({
      pickedAt: undefined,
      pickedAddress: undefined,
      pickedLat: undefined,
      pickedLng: undefined,
      pickedKind: undefined,
    } as never);
  }, [route.params, navigation, updateDraft]);

  const openPicker = () => {
    const init = draft.pickup
      ? {latitude: draft.pickup.latitude, longitude: draft.pickup.longitude, address: draft.pickup.address}
      : undefined;
    navigation.navigate('LocationPicker', {
      kind: 'pickup',
      countryCode: draft.zone_code || 'AE',
      initial: init,
      onPickRouteKey: 'ExecTask',
    });
  };

  // Step 3 of the wizard IS the picker: on first entry (no location yet) open
  // it immediately — it sits ABOVE this screen, so confirming pops back here
  // with the pick (same stack shape as the Lite wizard). Once only per mount;
  // a user who backs out of the picker chooses via the row instead.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || draft.pickup) {return;}
    autoOpened.current = true;
    openPicker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canContinue = !!draft.pickup;

  const handleContinue = () => {
    if (!canContinue) {return;}
    navigation.navigate('ExecTransport');
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View pointerEvents="none" style={s.ambient} />

      {/* ── Header ── */}
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
          <Text style={s.headerTitle}>Task Details</Text>
          <FitLine style={s.headerSub} text={'EXECUTIVE PROTECTION · STEP 4 · TASK TYPE'} />
        </View>
      </View>

      <KeyboardAvoidingScreen
        contentContainerStyle={s.scrollContent}
        footer={
          <LinearGradient
            colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
            locations={[0, 0.5]}
            style={[s.ctaWrap, {paddingBottom: safeBottom + 12}]}>
            {!canContinue && (
              <Text style={s.gateHint}>Confirm your service location to continue.</Text>
            )}
            <TouchableOpacity
              activeOpacity={canContinue ? 0.9 : 1}
              disabled={!canContinue}
              onPress={handleContinue}
              accessibilityRole="button"
              accessibilityState={{disabled: !canContinue}}>
              <LinearGradient
                colors={canContinue ? ['#6E9BF5', D.accent, D.accentDeep] : ['#27324A', '#1C2436']}
                locations={[0, 0.55, 1]}
                start={{x: 0, y: 0}}
                end={{x: 0, y: 1}}
                style={[s.cta, !canContinue && s.ctaDisabled]}>
                <Text style={s.ctaText}>Continue</Text>
                <Icon name="arrow-right" size={19} color="#fff" importantForAccessibility="no" />
              </LinearGradient>
            </TouchableOpacity>
          </LinearGradient>
        }>
        <Text style={s.lede}>What type of protection do you require?</Text>

        {/* Service location (picked on the previous step, editable) */}
        <View>
          <Text style={s.fieldLabel}>SERVICE LOCATION</Text>
          <TouchableOpacity
            style={[s.locRow, draft.pickup ? s.locRowFilled : s.locRowIdle]}
            onPress={openPicker}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={draft.pickup ? `Service location: ${draft.pickup.address}. Edit` : 'Select service location'}>
            <View style={[s.locPin, draft.pickup ? s.locPinFilled : s.locPinIdle]}>
              <Icon
                name={draft.pickup ? 'map-marker' : 'map-marker-outline'}
                size={16}
                color={draft.pickup ? D.accent : D.textMute}
              />
            </View>
            <Text
              style={[s.locText, draft.pickup ? s.locTextFilled : s.locTextPlaceholder]}
              numberOfLines={2}>
              {draft.pickup?.address ?? 'Select service location…'}
            </Text>
            <Text style={s.locEdit}>{draft.pickup ? 'Edit' : ''}</Text>
            <Icon name="chevron-right" size={16} color={D.textMute} />
          </TouchableOpacity>
        </View>

        {/* Task type — accordion select */}
        <View>
          <Text style={s.fieldLabel}>TASK TYPE</Text>
          <TouchableOpacity
            style={s.typeRow}
            onPress={() => setTypeOpen(o => !o)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{expanded: typeOpen}}
            accessibilityLabel={`Task type: ${execTaskLabel(draft.task_type)}`}>
            <View style={s.typeIcon}>
              <Icon
                name={EXEC_TASK_TYPES.find(t => t.key === draft.task_type)?.icon ?? 'shield-account'}
                size={16}
                color={D.accentSoft}
              />
            </View>
            <Text style={s.typeText} numberOfLines={1}>{execTaskLabel(draft.task_type)}</Text>
            <Icon name={typeOpen ? 'chevron-up' : 'chevron-down'} size={18} color={D.textMute} />
          </TouchableOpacity>

          {typeOpen && (
            <View style={s.typeList}>
              {EXEC_TASK_TYPES.map((t, i) => {
                const selected = t.key === draft.task_type;
                return (
                  <TouchableOpacity
                    key={t.key}
                    style={[s.typeOption, i > 0 && s.typeOptionDivider]}
                    onPress={() => {
                      updateDraft({task_type: t.key});
                      setTypeOpen(false);
                    }}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityState={{selected}}>
                    <Icon name={t.icon} size={16} color={selected ? D.accentSoft : D.textMute} />
                    <Text style={[s.typeOptionText, selected && s.typeOptionTextOn]} numberOfLines={1}>
                      {t.label}
                    </Text>
                    {selected && <Icon name="check" size={16} color={D.accent} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        {/* Further description */}
        <View>
          <Text style={s.fieldLabel}>FURTHER DESCRIPTION (OPTIONAL)</Text>
          <TextInput
            style={s.notes}
            value={draft.notes}
            onChangeText={t => updateDraft({notes: t.slice(0, NOTES_MAX)})}
            placeholder="e.g. Event support at hotel, access control at site entrance, discreet presence, etc."
            placeholderTextColor={D.textFaint}
            multiline
            textAlignVertical="top"
            maxLength={NOTES_MAX}
            accessibilityLabel="Further description"
          />
          <Text style={s.notesCount}>{draft.notes.length}/{NOTES_MAX}</Text>
        </View>
      </KeyboardAvoidingScreen>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, overflow: 'hidden'},

  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 260, borderRadius: 230,
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

  // Footer renders in-flow (KeyboardAvoidingScreen), not overlaid — modest
  // bottom padding only.
  scrollContent: {paddingHorizontal: 20, paddingBottom: 40, paddingTop: 4, gap: 16},

  lede: {fontFamily: D.fSans, fontSize: 13, lineHeight: 19, color: D.textDim},

  fieldLabel: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.8, color: D.textDim, marginBottom: 9, paddingLeft: 2,
  },

  locRow: {
    minHeight: 58, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  locRowFilled: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locRowIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  locPin: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  locPinFilled: {backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)'},
  locPinIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locText: {flex: 1, minWidth: 0, fontSize: 13.5, letterSpacing: -0.1, lineHeight: 18},
  locTextFilled: {fontFamily: D.fSemi, color: D.text},
  locTextPlaceholder: {fontFamily: D.fSans, color: D.textFaint},
  locEdit: {fontFamily: D.fSemi, fontSize: 12, color: D.accentSoft},

  typeRow: {
    minHeight: 56, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  typeIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  typeText: {flex: 1, minWidth: 0, fontFamily: D.fSemi, fontSize: 14.5, letterSpacing: -0.1, color: D.text},

  typeList: {
    marginTop: 8, borderRadius: 16, overflow: 'hidden',
    backgroundColor: 'rgba(16,26,46,0.6)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
  },
  typeOption: {
    minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14,
  },
  typeOptionDivider: {borderTopWidth: 1, borderTopColor: D.hair},
  typeOptionText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 13.5, color: D.textDim},
  typeOptionTextOn: {fontFamily: D.fSemi, color: D.text},

  notes: {
    minHeight: 120, borderRadius: 16, padding: 14, paddingTop: 12,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
    fontFamily: D.fSans, fontSize: 13.5, lineHeight: 19, color: D.text,
  },
  notesCount: {
    fontFamily: D.fMono, fontSize: 10, color: D.textMute,
    textAlign: 'right', marginTop: 6, paddingRight: 2,
  },

  gateHint: {fontFamily: D.fSans, fontSize: 11.5, color: D.amber, textAlign: 'center', marginBottom: 8},

  ctaWrap: {paddingHorizontal: 20, paddingTop: 20},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaDisabled: {borderColor: D.hair2, shadowOpacity: 0, elevation: 0},
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
}));
