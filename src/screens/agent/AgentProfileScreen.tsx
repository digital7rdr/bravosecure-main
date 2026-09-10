/**
 * Provider · My Profile — the real profile screen for agency and CPO accounts.
 *
 * Shared by two hosts: pushed as a stack screen from the Agent Portal drawer
 * and the Messenger drawer (AgentNavigator route "AgentProfile"), and mounted
 * directly as the CPO shell's "Me" tab (CpoNavigator). `navigation.canGoBack()`
 * decides whether a back chevron renders, so the same component works as
 * both a pushed screen and a tab root without a prop to thread through.
 *
 * Previously agency/CPO had no real profile — just a bare name/email Alert
 * (from the Messenger drawer) or a stub with only an org name + sign-out
 * (the old CpoMe tab). This surfaces the same identity + rename affordance
 * client accounts already have (`authStore.setDisplayName`, PATCH /auth/me),
 * plus the provider-specific facts (call sign, rating, jobs, region).
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, TextInput,
  Image, StatusBar, ActivityIndicator,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import {useAuthStore} from '@store/authStore';
import {agentApi, orgApi, type AgentPortalState} from '@services/api';
import {useAvatarPicker} from '@modules/profile/useAvatarPicker';
import {AvatarPhotoSheet} from '@modules/profile/AvatarPhotoSheet';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {regionName} from '@utils/regions';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair: 'rgba(255,255,255,0.06)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', accentDeep: '#2F5BE0',
  amber: '#F5C76B', signal: '#4ADE80', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold', fMono: 'monospace',
};

function initials(name: string | null | undefined): string {
  if (!name) {return 'B';}
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) {return 'B';}
  if (p.length === 1) {return p[0].slice(0, 2).toUpperCase();}
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

function InfoRow({icon, label, value}: {icon: React.ComponentProps<typeof Icon>['name']; label: string; value: string}) {
  return (
    <View style={s.infoRow}>
      <Icon name={icon} size={16} color={D.accentSoft} />
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

export default function AgentProfileScreen() {
  const insets = useSafeAreaInsets();
  // B-184 — modal backdrop lifts the whole column by the IME overlap (the rule's
  // container case); Android Modal windows never resize for the IME themselves.
  const {overlap} = useKeyboardLayout();
  const navigation = useNavigation<{navigate: (name: string, params?: object) => void; goBack: () => void; canGoBack: () => boolean}>();
  const {user, signOut, setDisplayName} = useAuthStore();
  const picker = useAvatarPicker();

  const [me, setMe] = useState<AgentPortalState | null>(null);
  const [photoSheet, setPhotoSheet] = useState(false);
  const [nameModal, setNameModal] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  // B-215 — the RATING/JOBS DONE stat cards below read me?.agent.rating /
  // jobs_total, which is the SELF agents-row (rating/jobs_total are written
  // against the provider/org user id — see org-cpo.service.ts's getCapacity
  // doc comment). For a delegated manager that's their own personal
  // managed-CPO row, not the agency's real numbers — same class of bug as
  // AgentDashboardScreen's cap.org_rating/org_jobs_total, fixed the same way.
  const [orgKpi, setOrgKpi] = useState<{rating: number | null; jobs_total: number} | null>(null);

  const load = useCallback(() => {
    agentApi.getMe().then(({data}) => setMe(data)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // Server-computed manager discriminator — see AgentDashboardScreen. The
  // client-side forms were all false for a real manager (a promoted CPO keeps
  // account_kind='cpo'), which here meant the role chip read "CPO" and the KPI
  // block silently showed their PERSONAL rating instead of the agency's.
  const isManager = !!user?.managed_org;

  useEffect(() => {
    const orgScoped = user?.account_kind === 'agency' || isManager;
    if (!orgScoped) { setOrgKpi(null); return; }
    orgApi.getSummary()
      .then(({data}) => setOrgKpi({rating: data.org_rating, jobs_total: data.org_jobs_total}))
      .catch(() => setOrgKpi(null));
  }, [user?.account_kind, isManager]);

  const displayName = user?.full_name ?? me?.agent.display_name ?? user?.email ?? 'Bravo user';
  const isCpo = user?.account_kind === 'cpo';
  // Manager wins over isCpo deliberately: a manager IS a promoted CPO, so both
  // are true and the chip must say the higher role. (isManager is derived
  // above, before the KPI effect that also needs it.)
  const roleLabel = isManager ? 'Manager' : isCpo ? 'CPO' : (me?.agent.type === 'company' ? 'Agency Owner' : 'Agent');
  const canGoBack = navigation.canGoBack();

  const openNameModal = () => { setNameDraft(displayName); setNameModal(true); };
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

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        {canGoBack ? (
          <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="chevron-left" size={26} color={D.text} />
          </TouchableOpacity>
        ) : <View style={s.back} />}
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>MY PROFILE</Text>
      </View>

      <ScrollView contentContainerStyle={{padding: 20, paddingBottom: insets.bottom + 28, gap: 16}} showsVerticalScrollIndicator={false}>
        <View style={s.idCard}>
          <TouchableOpacity style={s.avatarWrap} activeOpacity={0.85} onPress={() => setPhotoSheet(true)}>
            {user?.avatar_url ? (
              <Image source={{uri: user.avatar_url}} style={s.avatar} />
            ) : (
              <View style={[s.avatar, s.avatarFallback]}>
                <Text style={s.avatarText}>{initials(displayName)}</Text>
              </View>
            )}
            {picker.busy ? <View style={s.avatarBusy}><ActivityIndicator color="#fff" /></View> : null}
            <View style={s.cameraBadge}><Icon name="camera" size={12} color="#fff" /></View>
          </TouchableOpacity>

          <Text style={s.name} numberOfLines={1}>{displayName}</Text>
          <TouchableOpacity style={s.editRow} activeOpacity={0.7} onPress={openNameModal}>
            <Icon name="pencil-outline" size={13} color={D.accentSoft} />
            <Text style={s.editText}>Rename</Text>
          </TouchableOpacity>

          <View style={s.roleChip}><Text style={s.roleChipText}>{roleLabel}</Text></View>

          {(isCpo || isManager) && user?.org?.name ? (
            <Text style={s.orgLine}>Agency · {user.org.name}</Text>
          ) : null}
        </View>

        <View style={s.statsRow}>
          <View style={s.statBox}>
            {/* B-215 — prefer the org KPI (agency's real numbers) when this
                viewer is org-scoped; falls back to the personal agents-row
                figure for a plain individual CPO, same as the Dashboard. */}
            <Text style={s.statVal}>
              {orgKpi?.rating !== null && orgKpi?.rating !== undefined ? orgKpi.rating.toFixed(2)
                : me?.agent.rating ? Number(me.agent.rating).toFixed(2) : '—'}
            </Text>
            <Text style={s.statLabel}>RATING</Text>
          </View>
          <View style={s.statDivider} />
          <View style={s.statBox}>
            <Text style={s.statVal}>{orgKpi ? orgKpi.jobs_total : (me?.agent.jobs_total ?? 0)}</Text>
            <Text style={s.statLabel}>JOBS DONE</Text>
          </View>
          <View style={s.statDivider} />
          <View style={s.statBox}>
            <Text style={s.statVal}>{me?.agent.tier ? `T${me.agent.tier}` : '—'}</Text>
            <Text style={s.statLabel}>TIER</Text>
          </View>
        </View>

        <View style={s.card}>
          <Text style={s.cardLabel}>ACCOUNT</Text>
          <InfoRow icon="email-outline" label="Email" value={user?.email ?? '—'} />
          <InfoRow icon="phone-outline" label="Phone" value={user?.phone_e164 ?? '—'} />
          {me?.agent.call_sign ? <InfoRow icon="tag-outline" label="Call sign" value={me.agent.call_sign} /> : null}
          {me?.agent.region_code ? <InfoRow icon="map-marker-outline" label="Region" value={regionName(me.agent.region_code)} /> : null}
        </View>

        <TouchableOpacity style={s.signOutBtn} activeOpacity={0.85} onPress={() => void signOut()}>
          <Icon name="logout-variant" size={18} color={D.text} />
          <Text style={s.signOutText}>Log Out</Text>
        </TouchableOpacity>
      </ScrollView>

      <AvatarPhotoSheet
        visible={photoSheet}
        onClose={() => setPhotoSheet(false)}
        hasPhoto={picker.hasPhoto}
        onLibrary={() => { void picker.pickFromLibrary(); }}
        onCamera={() => { void picker.takePhoto(); }}
        onRemove={() => { void picker.removePhoto(); }}
      />

      <Modal visible={nameModal} transparent animationType="fade" onRequestClose={() => setNameModal(false)}>
        <View style={[s.modalOverlay, {paddingBottom: overlap}]}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rename</Text>
            <TextInput
              style={s.modalInput}
              value={nameDraft}
              onChangeText={setNameDraft}
              placeholder="Your name"
              placeholderTextColor={D.textMute}
              autoFocus
              maxLength={60}
              returnKeyType="done"
              onSubmitEditing={() => { void saveName(); }}
            />
            <View style={s.modalRow}>
              <TouchableOpacity style={s.modalCancel} activeOpacity={0.8} onPress={() => setNameModal(false)}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalSave, (!nameDraft.trim() || savingName) && {opacity: 0.4}]}
                disabled={!nameDraft.trim() || savingName}
                activeOpacity={0.85}
                onPress={() => { void saveName(); }}>
                {savingName ? <ActivityIndicator color="#fff" /> : <Text style={s.modalSaveText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 20, paddingVertical: 14},
  back: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  accentBar: {width: 3, height: 17, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 13, letterSpacing: 2.2, color: D.text},

  idCard: {
    alignItems: 'center', gap: 6, borderRadius: 20, padding: 24,
    backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2,
  },
  avatarWrap: {position: 'relative', marginBottom: 6},
  avatar: {width: 76, height: 76, borderRadius: 38},
  avatarFallback: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 2, borderColor: 'rgba(91,141,239,0.35)',
  },
  avatarText: {color: D.accentSoft, fontSize: 24, fontFamily: D.fBold},
  avatarBusy: {...StyleSheet.absoluteFillObject, borderRadius: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)'},
  cameraBadge: {
    position: 'absolute', bottom: 0, right: -2, width: 26, height: 26, borderRadius: 13,
    backgroundColor: D.accent, borderWidth: 2.5, borderColor: D.bg, alignItems: 'center', justifyContent: 'center',
  },
  name: {fontFamily: D.fBold, fontSize: 19, color: D.text, letterSpacing: -0.3},
  editRow: {flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2},
  editText: {fontFamily: D.fSemi, fontSize: 12, color: D.accentSoft},
  roleChip: {
    marginTop: 8, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)',
  },
  roleChipText: {fontFamily: D.fBold, fontSize: 10.5, letterSpacing: 1, color: D.accentSoft},
  orgLine: {fontFamily: D.fSans, fontSize: 12, color: D.textMute, marginTop: 6},

  statsRow: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 18, paddingVertical: 16,
    backgroundColor: 'rgba(255,255,255,0.02)', borderWidth: 1, borderColor: D.hair2,
  },
  statBox: {flex: 1, alignItems: 'center', gap: 3},
  statDivider: {width: StyleSheet.hairlineWidth, height: 28, backgroundColor: D.hair2},
  statVal: {fontFamily: D.fBold, fontSize: 17, color: D.text},
  statLabel: {fontFamily: D.fSemi, fontSize: 8.5, letterSpacing: 1, color: D.textMute},

  card: {borderRadius: 18, padding: 16, gap: 12, backgroundColor: 'rgba(255,255,255,0.02)', borderWidth: 1, borderColor: D.hair2},
  cardLabel: {fontFamily: D.fBold, fontSize: 10, letterSpacing: 1.5, color: D.textMute},
  infoRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  infoLabel: {flex: 1, fontFamily: D.fSans, fontSize: 12.5, color: D.textDim},
  infoValue: {fontFamily: D.fSemi, fontSize: 12.5, color: D.text, maxWidth: '55%'},

  signOutBtn: {
    flexDirection: 'row', gap: 8, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,93,93,0.07)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.26)',
  },
  signOutText: {fontFamily: D.fBold, fontSize: 14, color: D.alert, letterSpacing: 0.2},

  modalOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28},
  modalCard: {width: '100%', maxWidth: 360, borderRadius: 20, padding: 20, gap: 14, backgroundColor: '#0C1018', borderWidth: 1, borderColor: D.hair2},
  modalTitle: {fontFamily: D.fBold, fontSize: 16, color: D.text},
  modalInput: {
    height: 46, borderRadius: 12, paddingHorizontal: 14, fontFamily: D.fSans, fontSize: 14, color: D.text,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  modalRow: {flexDirection: 'row', gap: 10},
  modalCancel: {flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.04)'},
  modalCancelText: {fontFamily: D.fSemi, fontSize: 13.5, color: D.textDim},
  modalSave: {flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: D.accent},
  modalSaveText: {fontFamily: D.fBold, fontSize: 13.5, color: '#fff'},
}));
