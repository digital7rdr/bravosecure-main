/**
 * Provider · Add CPO — onboard an officer under the org's master licence.
 *
 * Premium redesign (Bravo "Add CPO" design handoff): obsidian base +
 * platinum-cobalt accent. Numbered sections with icon-led fields that light
 * up on focus/fill, a 0–4 REQUIRED completion meter under the header, a
 * GENERATE helper for the temporary password, the amber first-login notice,
 * a NEXT — OPS REVIEW compliance preview, and a sticky CTA that stays dim
 * until the form is complete.
 *
 * Data layer unchanged: orgApi.createCpo → success alert → back.
 */
import React, {useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  StatusBar,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {orgApi} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type IconName = React.ComponentProps<typeof Icon>['name'];

// Design tokens (Bravo "Add CPO" handoff — obsidian + platinum cobalt).
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentSoft: '#A9C5FF',
  accentDeep: '#2F5BE0',
  amber:      '#F5C76B',
  signal:     '#4ADE80',
  signalSoft: '#8FE6B4',
  fSans:  'Manrope_500Medium',
  fSemi:  'Manrope_600SemiBold',
  fBold:  'Manrope_700Bold',
  fMono:  'monospace',
};

// Random temp password the org can hand to the officer (reset on 1st login).
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!#%+';
  let out = '';
  for (let i = 0; i < 12; i++) {out += alphabet[Math.floor(Math.random() * alphabet.length)];}
  return out;
}

function SecLabel({n, children}: {n: string; children: string}) {
  return (
    <View style={s.secRow}>
      <View style={s.secChip}><Text style={s.secChipText}>{n}</Text></View>
      <Text style={s.secText}>{children}</Text>
      <View style={s.secLine} />
    </View>
  );
}

function Field({
  icon, label, optional, placeholder, value, onChange, mono, secure,
  keyboardType, autoCapitalize, trailing, focused, onFocus, onBlur,
}: {
  icon: IconName;
  label: string;
  optional?: boolean;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  secure?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  autoCapitalize?: 'none' | 'words';
  trailing?: React.ReactNode;
  focused: boolean;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const lit = focused || value.length > 0;
  return (
    <View>
      <View style={s.fieldLabelRow}>
        <Text style={s.fieldLabel}>{label}</Text>
        {optional && <View style={s.optChip}><Text style={s.optChipText}>OPTIONAL</Text></View>}
      </View>
      <View style={[s.fieldBox, lit && s.fieldBoxLit]}>
        <Icon name={icon} size={17} color={lit ? D.accentSoft : D.textFaint} />
        <TextInput
          style={[s.fieldInput, mono && s.fieldInputMono]}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={D.textFaint}
          secureTextEntry={secure}
          keyboardType={keyboardType ?? 'default'}
          autoCapitalize={autoCapitalize ?? 'none'}
          autoCorrect={false}
          onFocus={onFocus}
          onBlur={onBlur}
        />
        {trailing}
      </View>
    </View>
  );
}

export default function OrgCreateCpoScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useKeyboardLayout();
  const navigation = useNavigation<Nav>();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [callSign, setCallSign] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [pwVisible, setPwVisible] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Step 20 (G1) — onboard a CPO OR a Department Manager. The backend + API
  // already accept member_role; this is the only place that ever sends it.
  const [role, setRole] = useState<'cpo' | 'manager'>('cpo');
  const isManager = role === 'manager';

  // Completion meter — the 4 REQUIRED fields, counted when actually valid.
  const nameOk  = displayName.trim().length >= 2;
  const emailOk = /\S+@\S+\.\S+/.test(email);
  const phoneOk = phone.trim().length >= 6;
  const pwOk    = tempPassword.length >= 8;
  const reqDone = [nameOk, emailOk, phoneOk, pwOk].filter(Boolean).length;
  const pct = (reqDone / 4) * 100;
  const valid = reqDone === 4;

  const onGenerate = () => {
    setTempPassword(generatePassword());
    setPwVisible(true); // the manager must be able to read it to hand it over
  };

  const submit = async () => {
    if (!valid || submitting) {return;}
    setSubmitting(true);
    try {
      await orgApi.createCpo({
        display_name: displayName.trim(),
        email: email.trim(),
        phone_e164: phone.trim(),
        temp_password: tempPassword,
        call_sign: callSign.trim() || undefined,
        member_role: role,
      });
      Alert.alert(
        isManager ? 'Manager added' : 'CPO added',
        isManager
          ? `${displayName.trim()} can sign in with the temporary password. As a manager they review attendance, manage channels and the incident queue.`
          : `${displayName.trim()} can now sign in with the temporary password. They will be prompted to reset it.`,
        [{text: 'Done', onPress: () => navigation.goBack()}],
      );
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Could not add CPO', msg ?? (e as Error).message ?? 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />

      {/* ── Header + completion meter ── */}
      <View style={s.header}>
        <View style={s.headerRow}>
          <TouchableOpacity style={s.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="chevron-left" size={21} color={D.text} />
          </TouchableOpacity>
          <View style={s.accentBar} />
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.headerTitle}>{isManager ? 'ADD MANAGER' : 'ADD CPO'}</Text>
            <FitLine style={s.headerSub} text={isManager ? 'Onboard a department manager' : 'Onboard a close-protection officer'} />
          </View>
        </View>
        <View style={s.progressRow}>
          <View style={s.progressTrack}>
            <LinearGradient
              colors={[D.accent, '#6E9BF5']} start={{x: 0, y: 0}} end={{x: 1, y: 0}}
              style={[s.progressFill, {width: `${pct}%`}]} />
          </View>
          <Text style={[s.progressText, valid && {color: D.signal}]}>{reqDone}/4 REQUIRED</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>

        {/* Step 20 — role selector (default CPO). A Manager is seeded as a channel
            admin and admitted by OrgManagerGuard Path 2; a CPO is a standard member. */}
        <View style={{gap: 8}}>
          <Text style={[s.fieldLabel, {paddingLeft: 2}]}>MEMBER ROLE</Text>
          <View style={s.segment}>
            {(['cpo', 'manager'] as const).map(r => {
              const on = role === r;
              return (
                <TouchableOpacity key={r} style={[s.segBtn, on && s.segBtnOn]} activeOpacity={0.85} onPress={() => setRole(r)}>
                  <Icon name={r === 'manager' ? 'account-tie-outline' : 'shield-account-outline'} size={16} color={on ? '#fff' : D.textMute} />
                  <Text style={[s.segText, on && s.segTextOn]}>{r === 'manager' ? 'Manager' : 'CPO'}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={s.roleHint}>
            {isManager
              ? 'Reviews attendance, manages channels and works the incident queue.'
              : 'Checks in to shifts and reports incidents.'}
          </Text>
        </View>

        <SecLabel n="01">OFFICER IDENTITY</SecLabel>
        <Field icon="account-outline" label="FULL NAME" placeholder="e.g. Jane Doe"
          value={displayName} onChange={setDisplayName} autoCapitalize="words"
          focused={focusKey === 'name'} onFocus={() => setFocusKey('name')} onBlur={() => setFocusKey(null)} />
        <Field icon="email-outline" label="EMAIL" placeholder="cpo@example.com"
          value={email} onChange={setEmail} keyboardType="email-address"
          focused={focusKey === 'email'} onFocus={() => setFocusKey('email')} onBlur={() => setFocusKey(null)} />
        <Field icon="phone-outline" label="PHONE (E.164)" placeholder="+9715xxxxxxx" mono
          value={phone} onChange={setPhone} keyboardType="phone-pad"
          focused={focusKey === 'phone'} onFocus={() => setFocusKey('phone')} onBlur={() => setFocusKey(null)} />
        <Field icon="tag-outline" label="CALL SIGN" optional placeholder="CPO-91" mono
          value={callSign} onChange={setCallSign} autoCapitalize="words"
          focused={focusKey === 'callsign'} onFocus={() => setFocusKey('callsign')} onBlur={() => setFocusKey(null)} />

        <SecLabel n="02">FIRST-LOGIN ACCESS</SecLabel>
        <Field icon="lock-outline" label="TEMPORARY PASSWORD" placeholder="Min 8 characters" mono
          secure={!pwVisible}
          value={tempPassword} onChange={setTempPassword}
          focused={focusKey === 'pw'} onFocus={() => setFocusKey('pw')} onBlur={() => setFocusKey(null)}
          trailing={
            <TouchableOpacity style={s.generateChip} onPress={onGenerate} activeOpacity={0.7}>
              <Text style={s.generateText}>GENERATE</Text>
            </TouchableOpacity>
          } />

        {/* info banner */}
        <View style={s.banner}>
          <Icon name="alert-outline" size={18} color={D.amber} style={{marginTop: 1}} />
          <Text style={s.bannerText}>
            The CPO signs in with this temporary password and is prompted to set their own.
            KYC & compliance documents are reviewed by ops before dispatch.
          </Text>
        </View>

        {/* compliance preview */}
        <View style={{gap: 10}}>
          <Text style={s.nextLabel}>NEXT — OPS REVIEW</Text>
          <View style={{flexDirection: 'row', gap: 8}}>
            {['Security License', 'ID / KYC', 'Right to Work'].map(c => (
              <View key={c} style={s.complianceChip}>
                <View style={s.complianceCircle} />
                <Text style={s.complianceText}>{c}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={{height: 8}} />
      </ScrollView>

      {/* ── Sticky CTA — B-184: bottom-most node owns the keyboard inset ── */}
      <LinearGradient colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']} locations={[0, 0.28]}
        style={{paddingHorizontal: 20, paddingTop: 14, paddingBottom: bottomPad(14)}}>
        <TouchableOpacity activeOpacity={0.85} disabled={!valid || submitting}
          onPress={() => { void submit(); }}>
          {valid && !submitting ? (
            <LinearGradient colors={['#6E9BF5', D.accent, D.accentDeep]} style={s.cta}>
              <Icon name="plus" size={19} color="#fff" />
              <Text style={s.ctaText}>{isManager ? 'Add Manager to Roster' : 'Add CPO to Roster'}</Text>
            </LinearGradient>
          ) : (
            <View style={[s.cta, s.ctaDisabled]}>
              <Icon name="plus" size={19} color="rgba(255,255,255,0.8)" />
              <Text style={[s.ctaText, {color: 'rgba(255,255,255,0.8)'}]}>
                {submitting ? 'Adding…' : (isManager ? 'Add Manager to Roster' : 'Add CPO to Roster')}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </LinearGradient>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},

  // header
  header: {paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: D.hair},
  headerRow: {flexDirection: 'row', alignItems: 'center', gap: 13},
  backBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  accentBar: {
    width: 3, height: 16, borderRadius: 2, backgroundColor: D.accent,
    shadowColor: D.accent, shadowOpacity: 0.8, shadowRadius: 8, shadowOffset: {width: 0, height: 0},
  },
  headerTitle: {fontFamily: D.fBold, fontSize: 13, letterSpacing: 2, color: D.text},
  headerSub: {fontFamily: D.fSans, fontSize: 11, color: D.textMute, marginTop: 2, letterSpacing: -0.05},

  progressRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14},
  progressTrack: {flex: 1, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.07)', overflow: 'hidden'},
  progressFill: {height: '100%', borderRadius: 3},
  progressText: {fontFamily: D.fSemi, fontSize: 9.5, letterSpacing: 0.5, color: D.textMute},

  body: {paddingHorizontal: 20, paddingTop: 18, gap: 16},

  // role segmented control (Step 20)
  segment: {flexDirection: 'row', gap: 6, padding: 4, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)'},
  segBtn: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: 10},
  segBtnOn: {backgroundColor: '#5B8DEF'},
  segText: {fontFamily: 'Manrope_600SemiBold', fontSize: 13.5, color: 'rgba(180,188,204,0.45)'},
  segTextOn: {color: '#fff', fontFamily: 'Manrope_700Bold'},
  roleHint: {fontFamily: 'Manrope_500Medium', fontSize: 11.5, color: 'rgba(180,188,204,0.45)', paddingLeft: 2},

  // numbered section label
  secRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 2},
  secChip: {
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5,
    backgroundColor: 'rgba(91,141,239,0.1)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  secChipText: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 1, color: D.accentSoft},
  secText: {fontFamily: D.fSemi, fontSize: 10.5, letterSpacing: 2, color: D.textDim},
  secLine: {flex: 1, height: 1, backgroundColor: D.hair},

  // fields
  fieldLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8, paddingLeft: 2},
  fieldLabel: {fontFamily: D.fSemi, fontSize: 9.5, letterSpacing: 1.4, color: D.textMute},
  optChip: {
    paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair,
  },
  optChipText: {fontFamily: D.fSemi, fontSize: 8, letterSpacing: 0.8, color: D.textFaint},
  fieldBox: {
    flexDirection: 'row', alignItems: 'center', gap: 11, height: 52,
    paddingHorizontal: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.028)', borderWidth: 1, borderColor: D.hair2,
  },
  fieldBoxLit: {backgroundColor: 'rgba(91,141,239,0.06)', borderColor: 'rgba(91,141,239,0.4)'},
  fieldInput: {flex: 1, fontFamily: D.fSans, fontSize: 15, color: D.text, letterSpacing: -0.1, paddingVertical: 0},
  fieldInputMono: {fontFamily: D.fMono, fontSize: 14, letterSpacing: 0.4},

  generateChip: {
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8,
    backgroundColor: 'rgba(74,222,128,0.1)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)',
  },
  generateText: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 0.8, color: D.signalSoft},

  // info banner
  banner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    paddingVertical: 14, paddingHorizontal: 15, borderRadius: 14,
    backgroundColor: 'rgba(245,181,68,0.06)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.26)',
  },
  bannerText: {flex: 1, fontFamily: D.fSans, fontSize: 12, lineHeight: 18, color: D.textDim, letterSpacing: -0.05},

  // compliance preview
  nextLabel: {fontFamily: D.fSemi, fontSize: 9, letterSpacing: 1.2, color: D.textMute, paddingLeft: 2},
  complianceChip: {
    flex: 1, alignItems: 'center', gap: 7, paddingVertical: 12, paddingHorizontal: 6,
    borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  complianceCircle: {
    width: 16, height: 16, borderRadius: 8,
    borderWidth: 1.5, borderColor: D.textFaint, borderStyle: 'dashed',
  },
  complianceText: {fontFamily: D.fSans, fontSize: 10, color: D.textMute, letterSpacing: -0.1, textAlign: 'center'},

  // CTA
  cta: {
    height: 58, borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.45, shadowRadius: 19, shadowOffset: {width: 0, height: 8},
    elevation: 10,
  },
  ctaDisabled: {
    backgroundColor: 'rgba(255,255,255,0.07)', opacity: 0.55,
    shadowOpacity: 0, elevation: 0,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
}));
