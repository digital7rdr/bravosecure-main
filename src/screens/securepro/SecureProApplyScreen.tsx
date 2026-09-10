/**
 * Bravo Secure Pro — requirements form ("Build Your Requirements").
 *
 * Single-screen application: intended use, coverage duration + start date,
 * coverage area, personnel counts, gender preference, additional services,
 * notes. Submits POST /pro-applications (status PENDING_PROPOSAL) and lands
 * on the application status screen. Identity/KYC/linked members are NOT
 * collected here — they already exist on the account from signup.
 */
import React, {useMemo, useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, StatusBar, TextInput,
  Platform, Modal, Pressable, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import {useNavigation, CommonActions} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {useSecureProStore} from '@store/secureProStore';
import type {ProApplicationCreateBody} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureProApply'>;

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
  alert:      '#FF5D5D',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

type IconName = React.ComponentProps<typeof Icon>['name'];
type IntendedUse = ProApplicationCreateBody['intended_use'];
type GenderPref = ProApplicationCreateBody['gender_preference'];

const INTENDED_USES: Array<{key: IntendedUse; label: string; icon: IconName}> = [
  {key: 'family_support', label: 'Family Support', icon: 'account-heart'},
  {key: 'executive_protection', label: 'Executive Protection', icon: 'shield-account'},
  {key: 'travel_protection', label: 'Travel Protection', icon: 'airplane'},
  {key: 'residential_support', label: 'Residential Support', icon: 'home-lock'},
  {key: 'event_support', label: 'Event Support', icon: 'calendar-star'},
  {key: 'custom', label: 'Custom', icon: 'pencil-outline'},
];

const DURATIONS: Array<{months: number | null; label: string}> = [
  {months: 1, label: '1 Month'},
  {months: 3, label: '3 Months'},
  {months: 6, label: '6 Months'},
  {months: 12, label: '12 Months'},
  {months: null, label: 'Custom'},
];

const GENDER_PREFS: Array<{key: GenderPref; label: string}> = [
  {key: 'no_preference', label: 'No Preference'},
  {key: 'male', label: 'Male Team'},
  {key: 'female', label: 'Female Team'},
  {key: 'mixed', label: 'Mixed Team'},
];

const SERVICES: Array<{key: string; label: string; icon: IconName}> = [
  {key: 'secure_transfers', label: 'Secure Transfers', icon: 'car-estate'},
  {key: 'medical_support', label: 'Medical Support', icon: 'medical-bag'},
  {key: 'advance_assessment', label: 'Advance Assessment', icon: 'radar'},
  {key: 'secure_communications', label: 'Secure Communications', icon: 'phone-lock'},
  {key: 'journey_monitoring', label: 'Journey Monitoring', icon: 'map-marker-path'},
  {key: 'event_support', label: 'Event Support', icon: 'calendar-star'},
  {key: 'residential_support', label: 'Residential Support', icon: 'home-lock'},
  {key: 'other', label: 'Other', icon: 'dots-horizontal-circle-outline'},
];

function ymd(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function StepperRow({icon, label, value, onChange, max = 20}: {
  icon: IconName; label: string; value: number; onChange: (v: number) => void; max?: number;
}) {
  return (
    <View style={s.counter}>
      <View style={s.counterLeft}>
        <View style={s.counterIcon}>
          <Icon name={icon} size={17} color={D.accent} />
        </View>
        <Text style={s.counterLabel} numberOfLines={2}>{label}</Text>
      </View>
      <View style={s.counterCtrl}>
        <TouchableOpacity
          style={s.counterBtn}
          onPress={() => onChange(Math.max(0, value - 1))}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${label}`}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="minus" size={16} color={D.textDim} />
        </TouchableOpacity>
        <Text style={s.counterVal}>{value}</Text>
        <TouchableOpacity
          onPress={() => onChange(Math.min(max, value + 1))}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`Add ${label}`}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <LinearGradient
            colors={['#6E9BF5', D.accentDeep]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={s.counterBtnPri}>
            <Icon name="plus" size={16} color="#fff" />
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function SecureProApplyScreen() {
  const insets = useSafeAreaInsets();
  const {safeBottom} = useKeyboardLayout();
  const navigation = useNavigation<Nav>();
  const submitApplication = useSecureProStore(st => st.submitApplication);
  const isSubmitting = useSecureProStore(st => st.isSubmitting);
  const storeError = useSecureProStore(st => st.error);

  const [intendedUse, setIntendedUse] = useState<IntendedUse | null>(null);
  const [intendedUseNote, setIntendedUseNote] = useState('');
  const [durationMonths, setDurationMonths] = useState<number | null>(1);
  const [durationCustom, setDurationCustom] = useState(false);
  const [durationNote, setDurationNote] = useState('');
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [coverageArea, setCoverageArea] = useState('');
  const [cpoCount, setCpoCount] = useState(1);
  const [driverCount, setDriverCount] = useState(0);
  const [supportCount, setSupportCount] = useState(0);
  const [genderPref, setGenderPref] = useState<GenderPref>('no_preference');
  const [services, setServices] = useState<Set<string>>(new Set());
  const [serviceOtherNote, setServiceOtherNote] = useState('');
  const [notes, setNotes] = useState('');

  const minDate = useMemo(() => new Date(), []);

  const toggleService = (key: string) => {
    setServices(prev => {
      const next = new Set(prev);
      if (next.has(key)) {next.delete(key);} else {next.add(key);}
      return next;
    });
  };

  const onDateChange = (event: DateTimePickerEvent, date?: Date) => {
    if (Platform.OS === 'android') {setShowDatePicker(false);}
    if (event.type === 'set' && date) {setStartDate(date);}
  };

  const gateHint = useMemo(() => {
    if (!intendedUse) {return 'Select what you need Bravo Secure Pro for.';}
    if (intendedUse === 'custom' && !intendedUseNote.trim()) {return 'Describe your custom use case.';}
    if (durationCustom && !durationNote.trim()) {return 'Describe your custom coverage duration.';}
    if (!startDate) {return 'Pick a start date.';}
    if (coverageArea.trim().length < 3) {return 'Tell us the area you need covered.';}
    if (cpoCount + driverCount + supportCount < 1) {return 'Request at least one team member.';}
    if (services.has('other') && !serviceOtherNote.trim()) {return 'Describe the other service you need.';}
    return null;
  }, [intendedUse, intendedUseNote, durationCustom, durationNote, startDate,
    coverageArea, cpoCount, driverCount, supportCount, services, serviceOtherNote]);

  const handleSubmit = async () => {
    if (gateHint || !intendedUse || !startDate || isSubmitting) {return;}
    const body: ProApplicationCreateBody = {
      intended_use: intendedUse,
      ...(intendedUse === 'custom' ? {intended_use_note: intendedUseNote.trim()} : {}),
      ...(durationCustom
        ? {duration_note: durationNote.trim()}
        : {duration_months: durationMonths ?? 1}),
      start_date: ymd(startDate),
      coverage_area: coverageArea.trim(),
      cpo_count: cpoCount,
      driver_count: driverCount,
      support_staff_count: supportCount,
      gender_preference: genderPref,
      services: [...services],
      ...(services.has('other') ? {service_other_note: serviceOtherNote.trim()} : {}),
      ...(notes.trim() ? {notes: notes.trim()} : {}),
    };
    try {
      await submitApplication(body);
      // Land on the status screen AND scrub the intro + form out of history —
      // a back-swipe from "awaiting" must NOT resurface the stale application
      // form (resubmitting would 400 pro_application_exists). Back now goes
      // to whatever preceded the Pro funnel (chooser / home), and re-entering
      // the funnel routes straight back to the status screen.
      navigation.dispatch(state => {
        const routes = state.routes
          .filter(r => r.name !== 'SecureProIntro' && r.name !== 'SecureProApply')
          .concat([{name: 'SecureProStatus'} as (typeof state.routes)[number]]);
        return CommonActions.reset({...state, routes, index: routes.length - 1});
      });
    } catch {
      // Error surfaced inline via storeError.
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
          <Text style={s.headerTitle}>Build Your Requirements</Text>
          <FitLine style={s.headerSub} text={'BRAVO SECURE PRO · APPLICATION'} />
        </View>
      </View>

      <KeyboardAvoidingScreen
        contentContainerStyle={s.scrollContent}
        footer={
          <LinearGradient
            colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
            locations={[0, 0.4]}
            style={[s.ctaWrap, {paddingBottom: safeBottom + 12}]}>
            {storeError ? (
              <Text style={s.submitError} numberOfLines={2}>{storeError}</Text>
            ) : gateHint ? (
              <Text style={s.gateHint} numberOfLines={2}>{gateHint}</Text>
            ) : null}
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() => { void handleSubmit(); }}
              disabled={!!gateHint || isSubmitting}
              accessibilityRole="button"
              accessibilityLabel="Submit Pro request"
              accessibilityState={{disabled: !!gateHint || isSubmitting}}>
              <LinearGradient
                colors={gateHint
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
                    <Icon name="send" size={18} color="#fff" importantForAccessibility="no" />
                    <Text style={s.ctaText}>Submit Pro Request</Text>
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>
          </LinearGradient>
        }>

        {/* ── Intended use ── */}
        <Text style={s.sectionLabel}>INTENDED USE</Text>
        <View style={s.chipGrid}>
          {INTENDED_USES.map(u => {
            const on = intendedUse === u.key;
            return (
              <TouchableOpacity
                key={u.key}
                style={[s.useChip, on && s.useChipOn]}
                onPress={() => setIntendedUse(u.key)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={u.label}
                accessibilityState={{selected: on}}>
                <Icon name={u.icon} size={16} color={on ? D.accentSoft : D.textMute} />
                <Text style={[s.useChipText, on && s.useChipTextOn]} numberOfLines={1}>{u.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {intendedUse === 'custom' && (
          <TextInput
            style={s.input}
            value={intendedUseNote}
            onChangeText={setIntendedUseNote}
            placeholder="Describe your use case…"
            placeholderTextColor={D.textMute}
            selectionColor={D.accent}
            maxLength={200}
          />
        )}

        {/* ── Coverage ── */}
        <Text style={s.sectionLabel}>COVERAGE DURATION</Text>
        <View style={s.chipRow}>
          {DURATIONS.map(d => {
            const on = d.months === null ? durationCustom : (!durationCustom && durationMonths === d.months);
            return (
              <TouchableOpacity
                key={d.label}
                style={[s.durChip, on && s.durChipOn]}
                onPress={() => {
                  if (d.months === null) {setDurationCustom(true);}
                  else {setDurationCustom(false); setDurationMonths(d.months);}
                }}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={d.label}
                accessibilityState={{selected: on}}>
                <Text style={[s.durChipText, on && s.durChipTextOn]}>{d.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {durationCustom && (
          <TextInput
            style={s.input}
            value={durationNote}
            onChangeText={setDurationNote}
            placeholder="Describe the coverage period you need…"
            placeholderTextColor={D.textMute}
            selectionColor={D.accent}
            maxLength={200}
          />
        )}

        <Text style={s.sectionLabel}>START DATE</Text>
        <TouchableOpacity
          style={s.dateRow}
          onPress={() => setShowDatePicker(true)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={startDate ? `Start date ${ymd(startDate)}` : 'Pick a start date'}>
          <Icon name="calendar" size={16} color={D.accent} />
          <Text style={[s.dateText, !startDate && {color: D.textMute}]}>
            {startDate
              ? startDate.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'})
              : 'Select start date…'}
          </Text>
          <Icon name="chevron-down" size={16} color={D.textMute} />
        </TouchableOpacity>

        <Text style={s.sectionLabel}>COVERAGE AREA</Text>
        <TextInput
          style={s.input}
          value={coverageArea}
          onChangeText={setCoverageArea}
          placeholder="e.g. Dubai & Abu Dhabi, incl. airport transfers"
          placeholderTextColor={D.textMute}
          selectionColor={D.accent}
          maxLength={200}
        />

        {/* ── Team ── */}
        <Text style={s.sectionLabel}>REQUIRED PERSONNEL</Text>
        <View style={{gap: 10}}>
          <StepperRow icon="shield-account" label="Close Protection Officers" value={cpoCount} onChange={setCpoCount} />
          <StepperRow icon="steering" label="Drivers" value={driverCount} onChange={setDriverCount} />
          <StepperRow icon="account-group" label="Support Staff" value={supportCount} onChange={setSupportCount} />
        </View>

        <Text style={s.sectionLabel}>GENDER PREFERENCE</Text>
        <View style={s.chipRow}>
          {GENDER_PREFS.map(g => {
            const on = genderPref === g.key;
            return (
              <TouchableOpacity
                key={g.key}
                style={[s.durChip, on && s.durChipOn]}
                onPress={() => setGenderPref(g.key)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={g.label}
                accessibilityState={{selected: on}}>
                <Text style={[s.durChipText, on && s.durChipTextOn]}>{g.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Additional services ── */}
        <Text style={s.sectionLabel}>ADDITIONAL SERVICES</Text>
        <View style={s.svcCard}>
          {SERVICES.map((svc, i) => {
            const on = services.has(svc.key);
            return (
              <TouchableOpacity
                key={svc.key}
                style={[s.svcRow, i > 0 && s.svcRowBorder]}
                onPress={() => toggleService(svc.key)}
                activeOpacity={0.75}
                accessibilityRole="checkbox"
                accessibilityLabel={svc.label}
                accessibilityState={{checked: on}}>
                <View style={s.svcLeft}>
                  <Icon name={svc.icon} size={17} color={on ? D.accentSoft : D.textMute} />
                  <Text style={[s.svcLabel, on && {color: D.text}]}>{svc.label}</Text>
                </View>
                <View style={[s.checkbox, on && s.checkboxOn]}>
                  {on && <Icon name="check" size={13} color="#fff" />}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
        {services.has('other') && (
          <TextInput
            style={s.input}
            value={serviceOtherNote}
            onChangeText={setServiceOtherNote}
            placeholder="Describe the other service you need…"
            placeholderTextColor={D.textMute}
            selectionColor={D.accent}
            maxLength={200}
          />
        )}

        {/* ── Notes ── */}
        <Text style={s.sectionLabel}>NOTES</Text>
        <TextInput
          style={[s.input, s.inputMulti]}
          value={notes}
          onChangeText={setNotes}
          placeholder="Anything else the Bravo Control System should know…"
          placeholderTextColor={D.textMute}
          selectionColor={D.accent}
          multiline
          maxLength={1000}
          textAlignVertical="top"
        />

        <View style={s.kycNote}>
          <Icon name="shield-check" size={15} color={D.accentSoft} />
          <Text style={s.kycNoteText}>
            Your identity, documents and linked family members are already on file from your
            Bravo Secure account — no re-upload needed.
          </Text>
        </View>
      </KeyboardAvoidingScreen>

      {/* Date picker — platform split (Android inline dialog, iOS modal spinner). */}
      {Platform.OS === 'android' && showDatePicker && (
        <DateTimePicker
          value={startDate ?? new Date()}
          mode="date"
          display="default"
          minimumDate={minDate}
          onChange={onDateChange}
        />
      )}
      {Platform.OS === 'ios' && showDatePicker && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setShowDatePicker(false)}>
          <Pressable style={s.iosBackdrop} onPress={() => setShowDatePicker(false)}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <DateTimePicker
                value={startDate ?? new Date()}
                mode="date"
                display="spinner"
                minimumDate={minDate}
                textColor={D.text}
                onChange={onDateChange}
              />
              <TouchableOpacity activeOpacity={0.9} onPress={() => setShowDatePicker(false)}>
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.iosDone}>
                  <Text style={s.iosDoneText}>Done</Text>
                </LinearGradient>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}
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
  headerTitle: {fontFamily: D.fBold, fontSize: 20, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  headerSub: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  scrollContent: {paddingHorizontal: 20, paddingBottom: 170},

  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 22, marginBottom: 10,
  },

  chipGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 9},
  useChip: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingVertical: 10, paddingHorizontal: 13, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
    minWidth: '46%', flexGrow: 1,
  },
  useChipOn: {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.5)'},
  useChipText: {flexShrink: 1, minWidth: 0, fontFamily: D.fSemi, fontSize: 12.5, color: D.textDim},
  useChipTextOn: {color: D.text},

  chipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 9},
  durChip: {
    paddingVertical: 9, paddingHorizontal: 14, borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  durChipOn: {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.5)'},
  durChipText: {fontFamily: D.fSemi, fontSize: 12.5, color: D.textDim},
  durChipTextOn: {color: D.text},

  input: {
    marginTop: 10, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    color: D.text, fontFamily: D.fSans, fontSize: 13.5,
  },
  inputMulti: {minHeight: 96, paddingTop: 12},

  dateRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 13, paddingHorizontal: 14, paddingVertical: 13,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  dateText: {flex: 1, minWidth: 0, color: D.text, fontFamily: D.fSemi, fontSize: 13.5},

  counter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: 13, borderRadius: 15,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  counterLeft: {flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1, minWidth: 0},
  counterIcon: {
    width: 36, height: 36, borderRadius: 11, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  counterLabel: {flex: 1, minWidth: 0, color: D.text, fontFamily: D.fSemi, fontSize: 13},
  counterCtrl: {flexDirection: 'row', alignItems: 'center', gap: 12},
  counterBtn: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  counterBtnPri: {width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center'},
  counterVal: {minWidth: 20, textAlign: 'center', color: D.text, fontFamily: D.fBold, fontSize: 15},

  svcCard: {
    borderRadius: 16, backgroundColor: 'rgba(22,27,37,0.72)',
    borderWidth: 1, borderColor: D.hair, overflow: 'hidden',
  },
  svcRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 13, gap: 12,
  },
  svcRowBorder: {borderTopWidth: 1, borderTopColor: D.hair},
  svcLeft: {flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1, minWidth: 0},
  svcLabel: {flexShrink: 1, minWidth: 0, color: D.textDim, fontFamily: D.fSemi, fontSize: 13},
  checkbox: {
    width: 22, height: 22, borderRadius: 7, flexShrink: 0,
    borderWidth: 1.5, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: {backgroundColor: D.accent, borderColor: D.accent},

  kycNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    marginTop: 22, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
  },
  kycNoteText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 17, color: D.textDim},

  ctaWrap: {paddingHorizontal: 20, paddingTop: 20},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
  gateHint: {color: D.textMute, fontFamily: D.fSans, fontSize: 11.5, textAlign: 'center', marginBottom: 10},
  submitError: {color: D.alert, fontFamily: D.fSemi, fontSize: 11.5, textAlign: 'center', marginBottom: 10},

  iosBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)'},
  iosCard: {
    backgroundColor: '#10151F', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24,
  },
  iosDone: {minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 8},
  iosDoneText: {fontFamily: D.fBold, fontSize: 15, color: '#fff'},
}));
