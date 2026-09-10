import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, Image, Modal, TextInput, ActivityIndicator,
  TouchableOpacity, StatusBar, Linking } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {DynIcon} from '@components/DynIcon';
import {SwitchDashboardSection} from '@components/SwitchDashboardSection';
import {useWorkspaceSwitchRow} from '@components/useWorkspaceSwitchRow';
import {useAvatarPicker} from '@modules/profile/useAvatarPicker';
import {AvatarPhotoSheet} from '@modules/profile/AvatarPhotoSheet';
import {useAuthStore} from '@store/authStore';
import {walletApi, familyApi, type FamilyInvite} from '@/services/api';
import {APP_VERSION} from '@utils/constants';
import {TestCrashButton} from '@modules/observability';
import {scaleTextStyles} from '@utils/scaling';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {BravoFont} from '@/theme/bravo';

// Obsidian / platinum-cobalt palette — imported "Bravo Profile" design.
const T = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#7FA8FF',
  accentGlow: 'rgba(91,141,239,0.35)',
  blue:       '#A9C5FF',
  signal:     '#4ADE80',
  gold:       '#E2C893',
  alert:      '#FF8585',
  card:       'rgba(18,22,30,0.85)',
} as const;

// A row's tap target: a SecureTab nested route, an external URL, or a toggle.
type RowAction =
  | {kind: 'route'; screen: string; params?: unknown}
  | {kind: 'url'; url: string}
  | {kind: 'toggle'}
  | {kind: 'none'};

type MenuRow = {
  icon: string;
  label: string;
  value?: string;
  toggle?: boolean;
  badge?: string;       // gold "UPGRADE"-style pill
  statusOn?: boolean;   // green "ON" pill (e.g. 2FA)
  action: RowAction;
};

type Section = {
  title: string;
  rows: MenuRow[];
};

const SECTIONS: Section[] = [
  {
    title: 'Account',
    rows: [
      {icon:'account-circle', label:'My Profile', action:{kind:'route', screen:'IndividualProfile'}},
      {icon:'calendar-check', label:'My Bookings', action:{kind:'route', screen:'BookingHistory'}},
      {icon:'translate', label:'Language & Region', action:{kind:'route', screen:'Settings'}},
      // Bravo Secure Pro is request-and-approval — this routes to the Secure
      // Plans chooser (which itself routes by application state), never to a
      // self-serve subscription page.
      {icon:'shield-star', label:'Secure Plans', badge:'PRO', action:{kind:'route', screen:'SecureServices'}},
    ],
  },
  {
    title: 'Security',
    rows: [
      {icon:'fingerprint', label:'Biometric Lock', toggle:true, action:{kind:'toggle'}},
      // 2FA (OTP) is enforced app-wide and has no separate config screen, so
      // this is a non-tappable status row, not a dead link.
      {icon:'two-factor-authentication', label:'Two-Factor Auth', statusOn:true, action:{kind:'none'}},
    ],
  },
  {
    title: 'Billing',
    rows: [
      // M1A rule 11 — the tier-management home (matrix + up/downgrade).
      // Hidden for org/provider accounts at render time (their billing is
      // payouts, not subscriptions) — see the isOrgAffiliated filter below.
      {icon:'tag-multiple', label:'Messenger Plans', badge:'PLANS', action:{kind:'route', screen:'Pricing'}},
      {icon:'credit-card-outline', label:'Payment Methods', action:{kind:'route', screen:'PaymentMethods'}},
      // Real wallet transaction history lives on the Credits screen's History
      // tab (walletApi.getTransactions), not BookingHistory (which is "My Bookings").
      {icon:'receipt', label:'Transaction History', action:{kind:'route', screen:'Credits', params:{tab:'history'}}},
    ],
  },
  {
    title: 'Support',
    rows: [
      {icon:'help-circle-outline', label:'Help & Support', action:{kind:'url', url:'https://bravosecure.app/support'}},
      {icon:'shield-lock-outline', label:'Privacy Policy', action:{kind:'url', url:'https://bravosecure.app/privacy'}},
      {icon:'file-document-outline', label:'Terms of Service', action:{kind:'url', url:'https://bravosecure.app/terms'}},
    ],
  },
];

// Custom pill toggle matching the design (the native Switch looks off-brand).
function PfToggle({on, onPress}: {on: boolean; onPress: () => void}) {
  return (
    <TouchableOpacity
      accessibilityRole="switch"
      accessibilityState={{checked: on}}
      onPress={onPress}
      activeOpacity={0.8}
      style={[
        styles.toggle,
        {
          backgroundColor: on ? T.accent : 'rgba(255,255,255,0.1)',
          borderColor: on ? 'rgba(255,255,255,0.2)' : T.hair2,
          justifyContent: on ? 'flex-end' : 'flex-start',
        },
      ]}>
      <View style={styles.toggleKnob} />
    </TouchableOpacity>
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-07 — Modal windows don't resize for the IME; re-center the
  // name-edit card in the space above the keyboard.
  const keyboardOverlap = useKeyboardOverlap();
  // TODO: tighten type — cross-tab nav into a nested stack needs a composite nav type.
  const navigation = useNavigation<{navigate: (screen: string, params?: unknown) => void}>();
  const {user, signOut, setDisplayName} = useAuthStore();
  // No dismiss: this is a full screen, not the drawer's modal, so the row
  // navigates immediately rather than waiting out a fade that isn't happening.
  const workspaceRow = useWorkspaceSwitchRow();
  const picker = useAvatarPicker();
  // Biometric Lock — opt-in, persisted. Default OFF until the user enables it
  // with a real scan.
  const [biometric, setBiometric] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  // Profile photo sheet + name-edit modal.
  const [photoSheet, setPhotoSheet] = useState(false);
  const [nameModal, setNameModal] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Restore the persisted biometric-lock preference on mount.
  useEffect(() => {
    void (async () => {
      const saved = await AsyncStorage.getItem('settings:biometricLock');
      if (saved === '1') {setBiometric(true);}
    })();
  }, []);

  // Real biometric enable: turning ON runs an actual Face/fingerprint scan
  // (expo picks the modality the device supports; device PIN is the fallback).
  // If the device has no biometric hardware / enrollment, or the scan fails,
  // we revert the toggle and tell the user. Turning OFF just clears the flag.
  // NAV-17 (2026-08-26 audit) — in-flight ref: `!biometric` is read from
  // render state, so a mash queued N keystore round-trips toggling to a
  // nondeterministic final state.
  const bioBusyRef = useRef(false);
  const handleBiometricToggleInner = useCallback(async (next: boolean) => {
    if (!next) {
      setBiometric(false);
      await AsyncStorage.setItem('settings:biometricLock', '0');
      // FIX-12 — keep the fail-closed mirror in lockstep. Without this a
      // toggle-OFF followed by a flag-read error on the next boot re-locks off
      // the stale mirror (escapable, but wrong).
      await AsyncStorage.setItem('settings:biometricLock:lastKnown', '0').catch(() => {});
      return;
    }
    const [hasHw, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (!hasHw) {
      Alert.alert('Not supported', 'This device has no biometric hardware.');
      return;
    }
    if (!enrolled) {
      Alert.alert(
        'No biometrics enrolled',
        'Add a fingerprint or face unlock in your device settings first, then enable Biometric Lock.',
      );
      return;
    }
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Confirm to enable Biometric Lock',
      // Allow the OS to fall back to device PIN if the biometric read fails.
      disableDeviceFallback: false,
      cancelLabel: 'Cancel',
    });
    if (res.success) {
      setBiometric(true);
      await AsyncStorage.setItem('settings:biometricLock', '1');
      // FIX-12 — the mirror is what the gate falls back to when the flag read
      // errors; it must learn about the enable NOW, not on the next boot.
      await AsyncStorage.setItem('settings:biometricLock:lastKnown', '1').catch(() => {});
    } else {
      setBiometric(false);
    }
  }, []);
  const handleBiometricToggle = useCallback(async (next: boolean) => {
    if (bioBusyRef.current) {return;}
    bioBusyRef.current = true;
    try {
      await handleBiometricToggleInner(next);
    } finally {
      bioBusyRef.current = false;
    }
  }, [handleBiometricToggleInner]);

  // Live credits — refetch on focus and every 60s so the balance stays current.
  const loadBalance = useCallback(() => {
    void walletApi.getBalance()
      .then(r => setCredits(r.data.bravo_credits))
      .catch(() => {});
  }, []);
  useFocusEffect(useCallback(() => { loadBalance(); }, [loadBalance]));
  useEffect(() => {
    const id = setInterval(loadBalance, 60_000);
    return () => clearInterval(id);
  }, [loadBalance]);

  // Pending family invites for this user (member side) — accept/decline.
  const [invites, setInvites] = useState<FamilyInvite[]>([]);
  const loadInvites = useCallback(() => {
    void familyApi.invites().then(r => setInvites(r.data.invites)).catch(() => {});
  }, []);
  useFocusEffect(useCallback(() => { loadInvites(); }, [loadInvites]));
  const respondInvite = (id: string, accept: boolean) => {
    const call = accept ? familyApi.accept(id) : familyApi.decline(id);
    void call.then(() => loadInvites()).catch(() => {});
  };

  const creditsLabel = credits === null ? '—' : `${credits.toLocaleString()} BC`;

  // Every row routes into SecureTab → BookingNavigator, opens a URL, or toggles.
  const handleRow = (action: RowAction) => {
    if (action.kind === 'route') {
      navigation.navigate('SecureTab', {screen: action.screen, params: action.params});
    } else if (action.kind === 'url') {
      Linking.openURL(action.url).catch(() => {});
    }
  };

  // CreditPaywall lives inside SecureTab → BookingNavigator. ProfileTab is a
  // sibling tab, so we cross-navigate via the nested-route syntax.
  const openTopUp = () => {
    navigation.navigate('SecureTab', {screen: 'CreditPaywall', params: {source: 'wallet'}});
  };

  const openEditProfile = () => {
    navigation.navigate('SecureTab', {screen: 'IndividualProfile'});
  };

  const openNameModal = () => {
    setNameDraft(user?.full_name ?? '');
    setNameModal(true);
  };
  const saveName = async () => {
    const n = nameDraft.trim();
    if (!n) {return;}
    setSavingName(true);
    try {
      await setDisplayName(n);
      setNameModal(false);
    } catch {
      Alert.alert('Could not save name', 'Please try again.');
    } finally {
      setSavingName(false);
    }
  };

  // IDN-03/20 — explicit destructive variant of sign-out. Double-confirm,
  // then signOut({wipeAtRest: true}) runs the full P0-S1 at-rest destroy.
  const handleSignOutAndWipe = () => {
    Alert.alert(
      'Sign out & remove data?',
      'This deletes your encrypted messages on this device. Messages backed up or on other devices are unaffected.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Continue', style: 'destructive', onPress: () => {
          Alert.alert(
            'Are you sure?',
            'Your messages on this device cannot be recovered without a backup.',
            [
              {text: 'Cancel', style: 'cancel'},
              {text: 'Sign out & remove', style: 'destructive', onPress: () => { void signOut({wipeAtRest: true}); }},
            ],
          );
        }},
      ],
    );
  };

  // Same derivation as the Profile tab icon so the two always match.
  const displayName = user?.full_name ?? user?.email ?? 'You';
  const initials = (displayName)
    .split(/[\s@.]/)
    .filter(Boolean)
    .map(w => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'B';
  const roleLabel =
    user?.role === 'corporate' ? 'Corporate' :
    user?.role === 'agent'     ? 'Agent'     :
    user?.role === 'ops'       ? 'Ops'       : 'Individual';

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Profile</Text>
        <TouchableOpacity style={styles.gearBtn} activeOpacity={0.7} onPress={openEditProfile}>
          <Icon name="cog-outline" size={20} color={T.textDim} />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 28}]}>

        {/* ── Identity + credits card ── */}
        <View style={styles.idCard}>
          <LinearGradient
            colors={['rgba(20,32,60,0.8)', 'rgba(12,17,27,0.7)']}
            start={{x: 0, y: 0}} end={{x: 1, y: 1}}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.idGlow} pointerEvents="none" />

          <View style={styles.idTop}>
            <TouchableOpacity style={styles.avatarWrap} activeOpacity={0.85} onPress={() => setPhotoSheet(true)}>
              <LinearGradient
                colors={[T.accentSoft, T.accent, T.accentDeep]}
                start={{x: 0.2, y: 0}} end={{x: 0.8, y: 1}}
                style={styles.avatarRing}>
                <View style={styles.avatarInner}>
                  {user?.avatar_url ? (
                    <Image source={{uri: user.avatar_url}} style={styles.avatarImg} />
                  ) : (
                    <Text style={styles.avatarText}>{initials}</Text>
                  )}
                  {picker.busy ? (
                    <View style={styles.avatarBusy}>
                      <ActivityIndicator color="#fff" />
                    </View>
                  ) : null}
                </View>
              </LinearGradient>
              <View style={styles.cameraBadge}>
                <Icon name="camera" size={12} color="#fff" />
              </View>
            </TouchableOpacity>
            <View style={{flex: 1, minWidth: 0}}>
              <View style={styles.nameRow}>
                <Text style={styles.name} numberOfLines={1}>{displayName}</Text>
                <View style={styles.tierBadge}>
                  <Text style={styles.tierBadgeText}>{roleLabel}</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.editRow} activeOpacity={0.7} onPress={openNameModal}>
                <Text style={styles.editText}>Edit Profile</Text>
                <Icon name="pencil-outline" size={13} color={T.blue} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.idDivider} />

          <View style={styles.creditsRow}>
            <View style={styles.creditChip}>
              <Icon name="star-four-points" size={20} color={T.gold} />
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={styles.creditLabel}>Bravo Credits</Text>
              <Text style={styles.creditValue} numberOfLines={1}>{creditsLabel}</Text>
            </View>
            <TouchableOpacity activeOpacity={0.85} onPress={openTopUp}>
              <LinearGradient
                colors={['#6E9BF5', T.accent, T.accentDeep]}
                start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                style={styles.topUpBtn}>
                <Text style={styles.topUpText}>Top Up</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>

        {/* Family invites — accept to share the holder's Bravo Credits */}
        {invites.map(inv => (
          <View key={inv.id} style={styles.inviteCard}>
            <Icon name="account-multiple-plus" size={20} color={T.blue} />
            <View style={{flex: 1}}>
              <Text style={styles.inviteTitle}>{inv.holderName} invited you to their family</Text>
              <Text style={styles.inviteSub}>
                You'll be able to use their Bravo Credits. While you're an active member, your
                last location is shared with them (turn off in Settings → Location sharing).
              </Text>
            </View>
            <TouchableOpacity style={styles.inviteAccept} onPress={() => respondInvite(inv.id, true)} activeOpacity={0.85}>
              <Text style={styles.inviteAcceptText}>Accept</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.inviteDecline} onPress={() => respondInvite(inv.id, false)} activeOpacity={0.8}>
              <Icon name="close" size={16} color={T.textMute} />
            </TouchableOpacity>
          </View>
        ))}

        {/* Sections */}
        {SECTIONS.map(section => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.sectionLabel}>{section.title}</Text>
            <View style={styles.card}>
              <View style={styles.cardTopHL} pointerEvents="none" />
              {section.rows.filter(row => {
                // M1A rule 7 — subscriptions are an individual concern;
                // org/provider accounts bill via payouts and never see Pricing.
                if (row.action.kind === 'route' && row.action.screen === 'Pricing') {
                  return !(user?.account_kind === 'agency' || user?.role === 'service_provider' ||
                    (user?.account_kind === 'cpo' && user?.membership_status === 'active'));
                }
                return true;
              }).map((row, i, rows) => {
                const last = i === rows.length - 1;
                const tappable = row.action.kind === 'route' || row.action.kind === 'url';
                return (
                  <TouchableOpacity key={row.label}
                    style={[styles.row, !last && styles.rowBorder]}
                    activeOpacity={tappable ? 0.7 : 1}
                    disabled={!tappable}
                    onPress={() => handleRow(row.action)}>
                    <View style={styles.rowIcon}>
                      <DynIcon name={row.icon} size={20} color={T.blue} />
                    </View>
                    <Text style={styles.rowLabel} numberOfLines={2}>{row.label}</Text>
                    {row.toggle ? (
                      <PfToggle on={biometric} onPress={() => { void handleBiometricToggle(!biometric); }} />
                    ) : (
                      <View style={styles.rowTrailing}>
                        {row.badge ? (
                          <View style={styles.upgradeBadge}>
                            <Text style={styles.upgradeText}>{row.badge}</Text>
                          </View>
                        ) : null}
                        {row.statusOn ? (
                          <View style={styles.onBadge}>
                            <Text style={styles.onText}>ON</Text>
                          </View>
                        ) : null}
                        {row.value ? <Text style={styles.rowValue}>{row.value}</Text> : null}
                        {tappable ? <Icon name="chevron-right" size={18} color={T.textMute} /> : null}
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ))}

        {/* B-91 M0 — the only sanctioned cross-product control (spec p.12/21/26):
            lists the two products the user is NOT in; switching remounts the
            client shell, resetting this product's stack. */}
        <View style={styles.switchSection}>
          {/* Founder 2026-08-21 — the drawer's SWITCH DASHBOARD carries a fourth
              row (Workspaces / Channels) and this one did not, so the same
              menu answered differently depending on how it was opened. Same
              hook, so the label, pill and destination cannot fork. */}
          <SwitchDashboardSection extraRowData={workspaceRow} />
        </View>

        {/* Sign out — plain variant preserves local encrypted history */}
        <TouchableOpacity style={styles.signOut} onPress={() => { void signOut(); }} activeOpacity={0.85}>
          <Icon name="logout" size={18} color={T.alert} />
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>

        {/* IDN-03/20 — destructive variant: wipes the at-rest messenger data */}
        <TouchableOpacity style={styles.signOutWipe} onPress={handleSignOutAndWipe} activeOpacity={0.85}>
          <Icon name="delete-forever-outline" size={16} color={T.alert} />
          <Text style={styles.signOutWipeText}>Sign out & remove data from this device</Text>
        </TouchableOpacity>

        {/* Crashlytics dev tools — auto-hides in production builds */}
        <TestCrashButton />

        {/* Version */}
        <View style={styles.versionWrap}>
          <Text style={styles.versionStudio}>OmniDevX Studio</Text>
          <Text style={styles.versionNum}>v{APP_VERSION}</Text>
        </View>
      </ScrollView>

      {/* Profile-photo action sheet (shared with CPO + agent profiles) */}
      <AvatarPhotoSheet
        visible={photoSheet}
        onClose={() => setPhotoSheet(false)}
        hasPhoto={picker.hasPhoto}
        onLibrary={() => { void picker.pickFromLibrary(); }}
        onCamera={() => { void picker.takePhoto(); }}
        onRemove={() => { void picker.removePhoto(); }}
      />

      {/* Name-edit modal */}
      <Modal visible={nameModal} transparent animationType="fade" onRequestClose={() => setNameModal(false)}>
        <View style={[styles.modalOverlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Edit name</Text>
            <TextInput
              style={styles.modalInput}
              value={nameDraft}
              onChangeText={setNameDraft}
              placeholder="Your name"
              placeholderTextColor={T.textMute}
              autoFocus
              maxLength={60}
              returnKeyType="done"
              onSubmitEditing={() => { void saveName(); }}
            />
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} activeOpacity={0.8} onPress={() => setNameModal(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSave, (!nameDraft.trim() || savingName) && {opacity: 0.4}]}
                disabled={!nameDraft.trim() || savingName}
                activeOpacity={0.85}
                onPress={() => { void saveName(); }}>
                {savingName ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalSaveText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: T.bg},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 8},
  headerTitle: {fontFamily: BravoFont.extraBold, fontSize: 26, letterSpacing: -0.6, color: T.text},
  gearBtn: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: T.hair2},

  content: {paddingHorizontal: 20, paddingTop: 8, gap: 22},

  // ── identity + credits card ──
  idCard: {position: 'relative', overflow: 'hidden', borderRadius: 22, padding: 20, borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)'},
  idGlow: {position: 'absolute', top: -50, right: -40, width: 180, height: 180, borderRadius: 90, backgroundColor: 'rgba(91,141,239,0.10)'},
  idTop: {flexDirection: 'row', alignItems: 'center', gap: 16},
  avatarWrap: {position: 'relative'},
  avatarRing: {width: 66, height: 66, borderRadius: 33, padding: 2.5, alignItems: 'center', justifyContent: 'center'},
  avatarInner: {width: '100%', height: '100%', borderRadius: 33, backgroundColor: '#0E1320', alignItems: 'center', justifyContent: 'center'},
  avatarText: {fontFamily: BravoFont.extraBold, fontSize: 23, color: T.text},
  avatarImg: {width: '100%', height: '100%', borderRadius: 33},
  avatarBusy: {...StyleSheet.absoluteFillObject, borderRadius: 33, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)'},
  cameraBadge: {position: 'absolute', bottom: -1, right: -1, width: 24, height: 24, borderRadius: 12, backgroundColor: T.accent, borderWidth: 2.5, borderColor: '#0E1320', alignItems: 'center', justifyContent: 'center'},
  nameRow: {flexDirection: 'row', alignItems: 'center', gap: 9},
  name: {flexShrink: 1, fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.4, color: T.text},
  tierBadge: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)'},
  tierBadgeText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1, color: T.blue, textTransform: 'uppercase'},
  editRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7},
  editText: {fontFamily: BravoFont.semiBold, fontSize: 13, color: T.blue, letterSpacing: -0.1},

  idDivider: {height: 1, backgroundColor: T.hair, marginVertical: 17},
  creditsRow: {flexDirection: 'row', alignItems: 'center', gap: 13},
  creditChip: {width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(212,179,122,0.16)', borderWidth: 1, borderColor: 'rgba(212,179,122,0.34)'},
  creditLabel: {fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 1.4, color: T.textMute, textTransform: 'uppercase'},
  creditValue: {fontFamily: BravoFont.extraBold, fontSize: 20, letterSpacing: -0.4, color: T.text, marginTop: 3},
  topUpBtn: {paddingHorizontal: 20, paddingVertical: 11, borderRadius: 13, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center'},
  topUpText: {fontFamily: BravoFont.bold, fontSize: 14, color: '#fff'},

  // ── invite ──
  inviteCard: {flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 13, backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)', borderRadius: 16},
  inviteTitle: {fontFamily: BravoFont.bold, fontSize: 12.5, color: T.text},
  inviteSub: {fontFamily: BravoFont.regular, fontSize: 10.5, color: T.textMute, marginTop: 2},
  inviteAccept: {paddingHorizontal: 13, paddingVertical: 8, borderRadius: 11, backgroundColor: T.accent},
  inviteAcceptText: {fontFamily: BravoFont.bold, fontSize: 11, color: '#fff'},
  inviteDecline: {width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.hair2},

  // ── sections ──
  section: {gap: 11},
  sectionLabel: {fontFamily: BravoFont.semiBold, fontSize: 10.5, letterSpacing: 2, color: T.textMute, textTransform: 'uppercase', marginLeft: 4},
  card: {position: 'relative', overflow: 'hidden', borderRadius: 20, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2, paddingHorizontal: 16},
  cardTopHL: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14},
  rowBorder: {borderBottomWidth: 1, borderBottomColor: T.hair},
  rowIcon: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.26)'},
  rowLabel: {flex: 1, fontFamily: BravoFont.semiBold, fontSize: 15, letterSpacing: -0.2, color: T.text},
  rowTrailing: {flexShrink: 0, maxWidth: '50%', flexDirection: 'row', alignItems: 'center', gap: 10},
  rowValue: {fontFamily: BravoFont.mono, fontSize: 10, letterSpacing: 0.5, color: T.textMute},
  upgradeBadge: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, backgroundColor: 'rgba(212,179,122,0.12)', borderWidth: 1, borderColor: 'rgba(212,179,122,0.34)'},
  upgradeText: {fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '800', letterSpacing: 1, color: T.gold},
  onBadge: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, backgroundColor: 'rgba(74,222,128,0.1)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)'},
  onText: {fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '700', letterSpacing: 0.8, color: T.signal},

  // ── toggle ──
  toggle: {width: 48, height: 28, borderRadius: 14, borderWidth: 1, padding: 3, flexDirection: 'row', alignItems: 'center'},
  toggleKnob: {width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff'},

  // ── sign out ──
  switchSection: {marginBottom: 18},
  signOut: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, height: 52, borderRadius: 16, backgroundColor: 'rgba(255,93,93,0.07)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.26)', marginTop: 2},
  signOutText: {fontFamily: BravoFont.bold, fontSize: 15, letterSpacing: 0.2, color: T.alert},
  signOutWipe: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 46, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,93,93,0.18)', marginTop: 10},
  signOutWipeText: {fontFamily: BravoFont.semiBold, fontSize: 12.5, letterSpacing: 0.1, color: T.alert, opacity: 0.85},

  versionWrap: {alignItems: 'center', gap: 2, paddingVertical: 4, opacity: 0.45},
  versionStudio: {fontFamily: BravoFont.semiBold, fontSize: 11, color: T.textMute},
  versionNum: {fontFamily: BravoFont.regular, fontSize: 10, color: T.textFaint},

  // ── name modal ──
  modalOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28},
  modalCard: {width: '100%', backgroundColor: '#11151D', borderRadius: 22, borderWidth: 1, borderColor: T.hair2, padding: 22},
  modalTitle: {fontFamily: BravoFont.extraBold, fontSize: 18, letterSpacing: -0.3, color: T.text, marginBottom: 16},
  modalInput: {height: 52, borderRadius: 14, paddingHorizontal: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: T.hair2, fontFamily: BravoFont.semiBold, fontSize: 16, color: T.text},
  modalRow: {flexDirection: 'row', gap: 12, marginTop: 18},
  modalCancel: {flex: 1, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.hair2},
  modalCancelText: {fontFamily: BravoFont.bold, fontSize: 15, color: T.textDim},
  modalSave: {flex: 1, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: T.accent},
  modalSaveText: {fontFamily: BravoFont.bold, fontSize: 15, color: '#fff'},
}));
