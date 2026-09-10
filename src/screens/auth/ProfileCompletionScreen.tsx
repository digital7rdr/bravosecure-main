import React, {useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  TextInput,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

const NATIONALITIES = [
  'United Arab Emirates', 'United Kingdom', 'United States', 'Saudi Arabia',
  'India', 'Pakistan', 'France', 'Germany', 'Canada', 'Australia',
];

export default function ProfileCompletionScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {safeBottom} = useKeyboardLayout();
  const [fullName, setFullName] = useState('');
  const [company, setCompany] = useState('');
  const [nationality, setNationality] = useState('United Arab Emirates');
  const [emergencyContact, setEmergencyContact] = useState('');
  const [showNatPicker, setShowNatPicker] = useState(false);

  const goToDashboard = () => {
    navigation.navigate('Main' as never);
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="arrow-left" size={22} color="#E2E8F0" />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingScreen
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 120}]}
        // B-184 — the CTA rides INSIDE the keyboard-avoiding box so it stays
        // reachable while a field is focused; its safe-area pad collapses there.
        footer={
          <View style={[styles.footer, {paddingBottom: safeBottom + 20}]}>
            <TouchableOpacity style={styles.completeBtn} onPress={goToDashboard} activeOpacity={0.85}>
              <Text style={styles.completeBtnText}>Complete Setup</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.skipBtn} onPress={goToDashboard} activeOpacity={0.7}>
              <Text style={styles.skipBtnText}>Skip for now</Text>
            </TouchableOpacity>
          </View>
        }>

        {/* Progress */}
        <View style={styles.progressSection}>
          <Text style={styles.progressStep}>Step 4 of 4</Text>
          <View style={styles.progressBar}>
            <View style={styles.progressFill} />
          </View>
        </View>

        {/* Heading */}
        <View style={styles.headingSection}>
          <Text style={styles.heading}>Complete your profile</Text>
          <Text style={styles.headingSub}>Help us personalise your experience</Text>
        </View>

        {/* Avatar upload */}
        <View style={styles.avatarSection}>
          <View style={styles.avatarCircle}>
            <Icon name="camera" size={28} color={Colors.primary} />
            <View style={styles.avatarAddBtn}>
              <Icon name="plus" size={14} color="#FFF" />
            </View>
          </View>
          <Text style={styles.uploadLabel}>Upload photo</Text>
        </View>

        {/* Fields */}
        <View style={styles.fields}>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>FULL NAME <Text style={styles.required}>*</Text></Text>
            <TextInput
              style={styles.fieldInput}
              placeholder="Enter your full name"
              placeholderTextColor="#475569"
              value={fullName}
              onChangeText={setFullName}
            />
          </View>

          <View style={styles.field}>
            <View style={styles.fieldLabelRow}>
              <Text style={styles.fieldLabel}>COMPANY / ORGANISATION</Text>
              <View style={styles.optionalBadge}>
                <Text style={styles.optionalText}>Optional</Text>
              </View>
            </View>
            <TextInput
              style={styles.fieldInput}
              placeholder="Enter company name"
              placeholderTextColor="#475569"
              value={company}
              onChangeText={setCompany}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>NATIONALITY</Text>
            <TouchableOpacity
              style={styles.pickerBtn}
              onPress={() => setShowNatPicker(!showNatPicker)}
              activeOpacity={0.8}>
              <Text style={styles.pickerValue}>{nationality}</Text>
              <Icon name="chevron-down" size={20} color="#64748B" />
            </TouchableOpacity>
            {showNatPicker && (
              <View style={styles.pickerDropdown}>
                {NATIONALITIES.map(nat => (
                  <TouchableOpacity
                    key={nat}
                    style={styles.pickerItem}
                    onPress={() => {setNationality(nat); setShowNatPicker(false);}}
                    activeOpacity={0.8}>
                    <Text style={[styles.pickerItemText, nat === nationality && {color: Colors.primary}]}>{nat}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>EMERGENCY CONTACT <Text style={styles.required}>*</Text></Text>
            <View style={styles.phoneField}>
              <View style={styles.dialCode}>
                <Text style={styles.dialCodeText}>+971</Text>
                <Icon name="chevron-down" size={14} color="#64748B" />
              </View>
              <TextInput
                style={styles.phoneInput}
                placeholder="50 000 0000"
                placeholderTextColor="#475569"
                keyboardType="phone-pad"
                value={emergencyContact}
                onChangeText={setEmergencyContact}
              />
            </View>
          </View>
        </View>

      </KeyboardAvoidingScreen>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {paddingHorizontal: 16, paddingBottom: 4},
  backBtn: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},

  content: {paddingHorizontal: 24, paddingTop: 4},

  progressSection: {marginBottom: 24},
  progressStep: {fontSize: 12, fontWeight: '500', color: Colors.primary, marginBottom: 6},
  progressBar: {height: 4, borderRadius: 2, backgroundColor: '#1C3B66'},
  progressFill: {height: '100%', borderRadius: 2, backgroundColor: Colors.primary, width: '100%'},

  headingSection: {marginBottom: 24},
  heading: {fontSize: 24, fontWeight: '700', color: '#FFFFFF', marginBottom: 4},
  headingSub: {fontSize: 14, color: '#B8C7E0'},

  avatarSection: {alignItems: 'center', gap: 8, marginBottom: 32},
  avatarCircle: {width: 96, height: 96, borderRadius: 48, borderWidth: 2, borderColor: Colors.primary, borderStyle: 'dashed', backgroundColor: 'rgba(30,136,255,0.05)', alignItems: 'center', justifyContent: 'center', position: 'relative'},
  avatarAddBtn: {position: 'absolute', bottom: 0, right: 0, width: 28, height: 28, borderRadius: 14, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center'},
  uploadLabel: {fontSize: 14, color: Colors.primary, fontWeight: '600'},

  fields: {gap: 16},
  field: {gap: 6},
  fieldLabelRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  fieldLabel: {fontSize: 12, fontWeight: '500', color: '#B8C7E0', textTransform: 'uppercase', letterSpacing: 1.5},
  required: {color: Colors.primary},
  fieldInput: {height: 56, backgroundColor: '#1B3A66', borderWidth: 1, borderColor: '#1C3B66', borderRadius: 12, paddingHorizontal: 16, fontSize: 14, color: '#FFFFFF'},
  optionalBadge: {backgroundColor: 'rgba(30,136,255,0.1)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.2)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99},
  optionalText: {fontSize: 10, fontWeight: '700', color: 'rgba(30,136,255,0.8)', textTransform: 'uppercase'},

  pickerBtn: {height: 56, backgroundColor: '#1B3A66', borderWidth: 1, borderColor: '#1C3B66', borderRadius: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  pickerValue: {fontSize: 14, color: '#FFFFFF'},
  pickerDropdown: {backgroundColor: '#162F54', borderWidth: 1, borderColor: '#1C3B66', borderRadius: 12, overflow: 'hidden', marginTop: 4},
  pickerItem: {paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1C3B66'},
  pickerItemText: {fontSize: 14, color: '#B8C7E0'},

  phoneField: {height: 56, backgroundColor: '#1B3A66', borderWidth: 1, borderColor: '#1C3B66', borderRadius: 12, flexDirection: 'row', alignItems: 'center', overflow: 'hidden'},
  // Why: alignSelf:'stretch', never height:'100%' — survives a future fixed→minHeight
  // conversion on `phoneField` (the B-682 orphaned-percentage class).
  dialCode: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, borderRightWidth: 1, borderRightColor: '#1C3B66', alignSelf: 'stretch'},
  dialCodeText: {fontSize: 14, fontWeight: '600', color: '#B8C7E0'},
  phoneInput: {flex: 1, paddingHorizontal: 16, fontSize: 14, color: '#FFFFFF'},

  footer: {paddingHorizontal: 24, paddingTop: 12, backgroundColor: Colors.background, gap: 10},
  completeBtn: {backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 16, alignItems: 'center'},
  completeBtnText: {fontSize: 15, fontWeight: '700', color: '#FFF'},
  skipBtn: {paddingVertical: 8, alignItems: 'center'},
  skipBtnText: {fontSize: 14, fontWeight: '500', color: '#7E8AA6'},
}));
