import React, {useState} from 'react';
import {
  View, Text, StyleSheet,
  TouchableOpacity, StatusBar, TextInput,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Step = 'personal' | 'contact' | 'credentials' | 'review';
const STEPS: Step[] = ['personal', 'contact', 'credentials', 'review'];
const STEP_LABELS = ['PERSONAL', 'CONTACT', 'CREDENTIALS', 'REVIEW'];

const CERTS = [
  'First Aid / Trauma Care',
  'Firearms Certified',
  'Defensive Driving — Level 3',
  'Counter-Surveillance',
  'Close Circuit (CCTV) Operations',
];

export default function AgentRegistrationScreen() {
  const insets = useSafeAreaInsets();
  const {safeBottom} = useKeyboardLayout();
  const navigation = useNavigation();
  const [step, setStep] = useState<Step>('personal');

  // Personal
  const [fullName, setFullName] = useState('James A. Whitfield');
  const [dob, setDob] = useState('14 / 03 / 1988');
  const [nationality, setNationality] = useState('British');
  const [passportNo, setPassportNo] = useState('GB-739-4157');
  const [gender, setGender] = useState<'male'|'female'|'other'>('male');

  // Contact
  const [phone, setPhone] = useState('+44 7911 234567');
  const [email, setEmail] = useState('james.whitfield@digital7.com');
  const [country, setCountry] = useState('United Kingdom');
  const [city, setCity] = useState('London');
  const [emergencyName, setEmergencyName] = useState('Sarah Whitfield');
  const [emergencyPhone, setEmergencyPhone] = useState('+44 7911 987654');

  // Credentials
  const [licence, setLicence] = useState('SIA Close Protection Licence');
  const [licenceNo, setLicenceNo] = useState('SIA-2024-CP—');
  const [licenceExpiry, setLicenceExpiry] = useState('15 / 04 / 2027');
  const [authority, setAuthority] = useState('UK Security Industry Authority');
  const [certs, setCerts] = useState<string[]>(['First Aid / Trauma Care','Firearms Certified','Defensive Driving — Level 3']);

  // Review
  const [agreed, setAgreed] = useState(false);

  const stepIdx = STEPS.indexOf(step);

  const toggleCert = (c: string) =>
    setCerts(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);

  const nextLabels: Record<Step, string> = {
    personal: 'NEXT: CONTACT',
    contact: 'NEXT: CREDENTIALS',
    credentials: 'NEXT: REVIEW',
    review: 'SUBMIT APPLICATION',
  };

  const handleNext = () => {
    const idx = stepIdx;
    if (idx < STEPS.length - 1) {
      setStep(STEPS[idx + 1]);
    }
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Agent Registration</Text>
      </View>

      {/* Step tabs */}
      <View style={styles.tabsRow}>
        {STEPS.map((s, i) => (
          <TouchableOpacity key={s} style={styles.tab} onPress={() => setStep(s)} activeOpacity={0.7}>
            <Text style={[
              styles.tabText,
              i === stepIdx && styles.tabTextActive,
              i < stepIdx && styles.tabTextDone,
            ]}>
              {STEP_LABELS[i]}
            </Text>
            <View style={[
              styles.tabUnderline,
              i === stepIdx && styles.tabUnderlineActive,
              i < stepIdx && styles.tabUnderlineDone,
            ]} />
          </TouchableOpacity>
        ))}
      </View>

      <KeyboardAvoidingScreen
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}
        // B-184 — the CTA rides INSIDE the keyboard-avoiding box, so it stays
        // reachable while a field is focused. Its own safe-area pad collapses
        // there (the IME is already covering the nav bar).
        footer={
          <View style={[styles.footer, {paddingBottom: safeBottom + 16}]}>
            <TouchableOpacity
              style={[styles.nextBtn, step === 'review' && !agreed && styles.nextBtnDisabled]}
              onPress={handleNext}
              activeOpacity={0.85}>
              <Text style={styles.nextBtnText}>{nextLabels[step]}</Text>
              <Icon name="arrow-right" size={16} color="#FFF" />
            </TouchableOpacity>
          </View>
        }>

        {/* PERSONAL */}
        {step === 'personal' && (
          <View style={styles.stepContent}>
            <Field label="Full Legal Name" value={fullName} onChange={setFullName} placeholder="As on passport" />
            <Field label="Date of Birth" value={dob} onChange={setDob} placeholder="DD / MM / YYYY" />
            <Field label="Nationality" value={nationality} onChange={setNationality} placeholder="Country of citizenship" />
            <Field label="National ID / Passport No." value={passportNo} onChange={setPassportNo} placeholder="Passport or national ID" />
            <View>
              <Text style={styles.fieldLabel}>Gender</Text>
              <View style={styles.genderRow}>
                {(['male','female','other'] as const).map(g => (
                  <TouchableOpacity key={g}
                    style={[styles.genderBtn, gender === g && styles.genderBtnActive]}
                    onPress={() => setGender(g)} activeOpacity={0.7}>
                    <Text style={[styles.genderBtnText, gender === g && styles.genderBtnTextActive]}>
                      {g.charAt(0).toUpperCase() + g.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        )}

        {/* CONTACT */}
        {step === 'contact' && (
          <View style={styles.stepContent}>
            <Field label="Mobile Number" value={phone} onChange={setPhone} placeholder="+971 5X XXX XXXX" keyboardType="phone-pad" />
            <Field label="Email Address" value={email} onChange={setEmail} placeholder="your@email.com" keyboardType="email-address" />
            <Field label="Country of Residence" value={country} onChange={setCountry} placeholder="Current country" />
            <Field label="City" value={city} onChange={setCity} placeholder="Current city" />
            <Field label="Emergency Contact Name" value={emergencyName} onChange={setEmergencyName} placeholder="Full name" />
            <Field label="Emergency Contact Number" value={emergencyPhone} onChange={setEmergencyPhone} placeholder="+X XXX XXX XXXX" keyboardType="phone-pad" />
          </View>
        )}

        {/* CREDENTIALS */}
        {step === 'credentials' && (
          <View style={styles.stepContent}>
            <Text style={styles.sectionLabel}>Professional Credentials</Text>
            <Field label="Primary Certification" value={licence} onChange={setLicence} placeholder="" />
            <Field label="Licence Number" value={licenceNo} onChange={setLicenceNo} placeholder="" />
            <Field label="Licence Expiry" value={licenceExpiry} onChange={setLicenceExpiry} placeholder="DD / MM / YYYY" />
            <Field label="Issuing Authority" value={authority} onChange={setAuthority} placeholder="" />
            <View>
              <Text style={styles.fieldLabel}>Additional Certifications</Text>
              <View style={styles.certList}>
                {CERTS.map(c => (
                  <TouchableOpacity key={c} style={styles.certRow} onPress={() => toggleCert(c)} activeOpacity={0.8}>
                    <View style={[styles.checkbox, certs.includes(c) && styles.checkboxActive]}>
                      {certs.includes(c) && <Icon name="check" size={12} color="#FFF" />}
                    </View>
                    <Text style={styles.certText}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        )}

        {/* REVIEW */}
        {step === 'review' && (
          <View style={styles.stepContent}>
            <ReviewSection title="PERSONAL" rows={[
              {label:'Full Name', value:'James A. Whitfield'},
              {label:'DOB', value:'14/03/1988'},
              {label:'Nationality', value:'British'},
              {label:'Passport', value:'GB-739-4157'},
            ]} />
            <ReviewSection title="CONTACT" rows={[
              {label:'Mobile', value:'+44 7911 234567'},
              {label:'Email', value:'james.whitfield@digital7.com'},
              {label:'Location', value:'London, UK'},
            ]} />
            <ReviewSection title="CREDENTIALS" rows={[
              {label:'Licence', value:'SIA Close Protection'},
              {label:'Expiry', value:'15/04/2027'},
              {label:'Certs', value:'First Aid, Firearms, Driving L3'},
            ]} />
            <TouchableOpacity style={styles.agreeRow} onPress={() => setAgreed(a => !a)} activeOpacity={0.8}>
              <View style={[styles.checkbox, agreed && styles.checkboxActive]}>
                {agreed && <Icon name="check" size={12} color="#FFF" />}
              </View>
              <Text style={styles.agreeText}>
                I confirm all information is accurate and agree to the{' '}
                <Text style={styles.agreeLink}>Terms & Conditions</Text> and Bravo partner agreement.
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingScreen>
    </View>
  );
}

function Field({label, value, onChange, placeholder, keyboardType}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; keyboardType?: 'default'|'phone-pad'|'email-address';
}) {
  return (
    <View>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#475569"
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize="none"
      />
    </View>
  );
}

function ReviewSection({title, rows}: {title: string; rows: {label: string; value: string}[]}) {
  return (
    <View style={styles.reviewCard}>
      <Text style={styles.reviewTitle}>{title}</Text>
      {rows.map((row, i) => (
        <View key={row.label} style={[styles.reviewRow, i < rows.length - 1 && styles.reviewRowBorder]}>
          <Text style={styles.reviewLabel}>{row.label}</Text>
          <Text style={styles.reviewValue}>{row.value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},
  header: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:16, paddingTop:6, paddingBottom:10},
  backBtn: {width:36, height:36, borderRadius:18, alignItems:'center', justifyContent:'center'},
  headerTitle: {color:'#E2E8F0', fontSize:14, fontWeight:'700'},
  stepBadge: {paddingHorizontal:8, paddingVertical:4, borderRadius:99, backgroundColor:'rgba(37,99,235,0.08)', borderWidth:1, borderColor:'rgba(37,99,235,0.3)'},
  stepBadgeText: {color:Colors.primary, fontSize:10, fontWeight:'800'},

  tabsRow: {flexDirection:'row', borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  tab: {flex:1, alignItems:'center', paddingVertical:10},
  tabText: {color:'#475569', fontSize:10, fontWeight:'800', letterSpacing:0.8},
  tabTextActive: {color:Colors.primary},
  tabTextDone: {color:Colors.primary, opacity:0.6},
  tabUnderline: {position:'absolute', bottom:0, left:0, right:0, height:2, backgroundColor:'transparent'},
  tabUnderlineActive: {backgroundColor:Colors.primary},
  tabUnderlineDone: {backgroundColor:'rgba(37,99,235,0.3)'},

  content: {paddingHorizontal:16, paddingTop:16},
  stepContent: {gap:14},

  fieldLabel: {color:'#64748B', fontSize:10, fontWeight:'800', letterSpacing:1.5, textTransform:'uppercase', marginBottom:6},
  fieldInput: {backgroundColor:'#0D1929', borderWidth:1, borderColor:'#1E2D45', borderRadius:10, paddingHorizontal:14, paddingVertical:11, fontSize:13, color:'#E2E8F0', fontWeight:'500'},
  sectionLabel: {color:'#475569', fontSize:10, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},

  genderRow: {flexDirection:'row', gap:8},
  genderBtn: {flex:1, paddingVertical:10, borderRadius:12, backgroundColor:'#0D1929', borderWidth:1, borderColor:'#1E2D45', alignItems:'center'},
  genderBtnActive: {backgroundColor:'rgba(37,99,235,0.12)', borderColor:'rgba(37,99,235,0.4)'},
  genderBtnText: {color:'#475569', fontSize:12, fontWeight:'700'},
  genderBtnTextActive: {color:'#93C5FD'},

  certList: {gap:8},
  certRow: {flexDirection:'row', alignItems:'center', gap:10, padding:10, borderRadius:10, borderWidth:1, borderColor:'#1E2D45', backgroundColor:'#0D1929'},
  checkbox: {width:18, height:18, borderRadius:4, borderWidth:1.5, borderColor:'#334155', alignItems:'center', justifyContent:'center', flexShrink:0},
  checkboxActive: {backgroundColor:Colors.primary, borderColor:Colors.primary},
  certText: {color:'#CBD5E1', fontSize:13},

  reviewCard: {backgroundColor:'#0D1929', borderWidth:1, borderColor:'#1E2D45', borderRadius:16, padding:16},
  reviewTitle: {color:Colors.primary, fontSize:10, fontWeight:'800', letterSpacing:2, textTransform:'uppercase', marginBottom:12},
  reviewRow: {flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start', paddingVertical:8},
  reviewRowBorder: {borderBottomWidth:1, borderBottomColor:'#1E2D45'},
  reviewLabel: {color:'#475569', fontSize:12},
  reviewValue: {color:'#E2E8F0', fontSize:12, fontWeight:'600', textAlign:'right', flex:1, marginLeft:12},

  agreeRow: {flexDirection:'row', alignItems:'flex-start', gap:12},
  agreeText: {flex:1, color:'#94A3B8', fontSize:12, lineHeight:20},
  agreeLink: {color:Colors.primary, fontWeight:'600'},

  footer: {paddingHorizontal:16, paddingTop:12, backgroundColor:Colors.background},
  nextBtn: {paddingVertical:14, borderRadius:12, backgroundColor:Colors.primary, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:8, shadowColor:Colors.primary, shadowOffset:{width:0,height:6}, shadowOpacity:0.35, shadowRadius:16, elevation:6},
  nextBtnDisabled: {opacity:0.4},
  nextBtnText: {color:'#FFF', fontSize:13, fontWeight:'800', letterSpacing:1},
}));
