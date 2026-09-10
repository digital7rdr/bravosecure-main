import React, {useCallback, useState} from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Modal,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {useAuthStore} from '@store/authStore';
import {familyApi, type FamilyMember, type FamilyUsage} from '@/services/api';
import {normalizeBatch, regionFromOwnPhone} from '@/modules/messenger/contacts/phoneNormalize';
import {BravoFont} from '@/theme/bravo';
import LoadingView from '@components/LoadingView';
import {isProActive} from '@utils/tier';
import {goBackOnce} from '@navigation/tapGuard';
import {FamilyQuotaCard} from './FamilyQuotaCard';

const MAX_SEATS = 4;

const T = {
  bg:        '#07090D',
  text:      '#F2F4F8',
  textDim:   'rgba(229,233,242,0.62)',
  textMute:  'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)',
  hair:      'rgba(255,255,255,0.06)',
  hair2:     'rgba(255,255,255,0.09)',
  accent:    '#5B8DEF',
  accentDeep:'#2F5BE0',
  accentSoft:'#7FA8FF',
  accentGlow:'rgba(91,141,239,0.35)',
  blue:      '#A9C5FF',
  signal:    '#4ADE80',
  gold:      '#E2C893',
  alert:     '#FF8585',
  card:      'rgba(18,22,30,0.85)',
} as const;

const USAGE_COLORS = ['#A9C5FF', '#6EE7B7', '#FCD34D', '#FCA5A5'];

function initialsOf(name: string): string {
  return name.split(/[\s@.+]/).filter(Boolean).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
}

export default function IndividualProfileScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // B-84 / KB-12 — Android Modal windows don't resize for the IME.
  const keyboardOverlap = useKeyboardOverlap();
  const {user} = useAuthStore();
  const [showInviteToast, setShowInviteToast] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  const holderName = user?.full_name ?? user?.email ?? 'Account Holder';
  const holderInitials = initialsOf(holderName);
  const tierLabel = isProActive(user) ? 'PRO' : 'INDIVIDUAL';

  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [usage, setUsage] = useState<FamilyUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    void familyApi.members()
      .then(r => setMembers(r.data.members))
      .catch(() => {})
      .finally(() => setLoading(false));
    void familyApi.usage().then(r => setUsage(r.data)).catch(() => {});
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const activeMembers = members.filter(m => m.status === 'active');
  const filled = Math.min(MAX_SEATS, activeMembers.length);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toast = (m: string) => { setToastMsg(m); setShowInviteToast(true); setTimeout(() => setShowInviteToast(false), 3000); };

  const handleAddMember = () => {
    if (activeMembers.length >= MAX_SEATS) {
      toast('Family is full (4 members max).');
      return;
    }
    setErr(null); setPhone(''); setLimit(''); setInviteOpen(true);
  };

  const submitInvite = async () => {
    setErr(null);
    const code = regionFromOwnPhone(user?.phone_e164 ?? null);
    const [e164] = normalizeBatch([phone], code);
    if (!e164) { setErr('Enter a valid phone number with country code.'); return; }
    const cap = limit.trim() ? Math.max(0, Math.floor(Number(limit))) : null;
    if (limit.trim() && !Number.isFinite(cap)) { setErr('Spend limit must be a number.'); return; }
    setBusy(true);
    try {
      await familyApi.invite(e164, cap);
      setInviteOpen(false);
      toast('Invite sent. They appear once they accept.');
      load();
    } catch (e) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      setErr(msg === 'family_full' ? 'Family is full.'
        : msg === 'cannot_invite_self' ? "That's your own number."
        : msg === 'member_in_another_family' ? 'They already belong to another family.'
        : msg === 'invite_already_pending' ? 'Invite already pending for that number.'
        : 'Could not send invite. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const removeMember = (id: string) => {
    void familyApi.remove(id).then(() => { toast('Member removed.'); load(); }).catch(() => {});
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={22} color={T.text} />
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>Individual Profile</Text>
          <Text style={styles.headerSub}>Manage your account & family</Text>
        </View>
        <View style={{width: 36}} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>

        {/* ── Identity card ── */}
        <View style={styles.idCard}>
          <LinearGradient colors={['rgba(20,32,60,0.8)', 'rgba(12,17,27,0.7)']} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={StyleSheet.absoluteFill} />
          <View style={styles.idGlow} pointerEvents="none" />
          <View style={styles.idRow}>
            {user?.avatar_url ? (
              <Image source={{uri: user.avatar_url}} style={styles.idAvatarImg} />
            ) : (
              <LinearGradient colors={['#7C5AD6', '#5B43C9']} start={{x: 0.2, y: 0}} end={{x: 0.8, y: 1}} style={styles.idAvatar}>
                <Text style={styles.idAvatarText}>{holderInitials}</Text>
              </LinearGradient>
            )}
            <View style={{flex: 1, minWidth: 0}}>
              <FitLine style={styles.idName} floorScale={0.7} text={holderName} />
              <View style={styles.idBadges}>
                <View style={[styles.badge, {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.34)'}]}>
                  <Text style={[styles.badgeText, {color: T.blue}]}>{tierLabel}</Text>
                </View>
                <View style={[styles.badge, {backgroundColor: 'rgba(212,179,122,0.12)', borderColor: 'rgba(212,179,122,0.4)'}]}>
                  <Text style={[styles.badgeText, {color: T.gold}]}>ACCOUNT HOLDER</Text>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* ── Your own spending limit, when you are a MEMBER of someone else's
            plan (spec §41/§42). Renders null otherwise, so an account holder
            who is not also a member sees nothing here. ── */}
        <FamilyQuotaCard />

        {/* ── Family members ── */}
        <View style={styles.sectionHead}>
          <Text style={styles.sectionLabel}>Family Members · {filled} / {MAX_SEATS} Max</Text>
          <TouchableOpacity activeOpacity={0.85} onPress={handleAddMember}>
            <LinearGradient colors={['#6E9BF5', T.accent, T.accentDeep]} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={styles.addBtn}>
              <Icon name="plus" size={18} color="#fff" />
            </LinearGradient>
          </TouchableOpacity>
        </View>

        <View style={styles.membersCard}>
          {/* capacity meter */}
          <View style={styles.meterWrap}>
            <View style={styles.meterRow}>
              {Array.from({length: MAX_SEATS}).map((_, i) => (
                i < filled
                  ? <LinearGradient key={i} colors={['#6E9BF5', T.accent]} start={{x: 0, y: 0}} end={{x: 1, y: 0}} style={styles.meterBar} />
                  : <View key={i} style={[styles.meterBar, {backgroundColor: 'rgba(255,255,255,0.07)'}]} />
              ))}
            </View>
            <View style={styles.meterLabelRow}>
              <Text style={styles.meterUsed}>{filled === 0 ? 'No seats used' : `${filled} of ${MAX_SEATS} seats used`}</Text>
              <Text style={styles.meterAvail}>{MAX_SEATS - filled} AVAILABLE</Text>
            </View>
          </View>

          {/* seat slots */}
          {loading ? (
            <View style={{paddingVertical: 28, alignItems: 'center'}}><LoadingView compact label="Loading profile…" /></View>
          ) : (
            <View style={styles.slotRow}>
              {Array.from({length: MAX_SEATS}).map((_, i) => {
                const m = activeMembers[i];
                if (m) {
                  return (
                    <View key={i} style={styles.slot}>
                      <View style={styles.slotAvatar}><Text style={styles.slotAvatarText}>{initialsOf(m.name)}</Text></View>
                      <FitLine style={[styles.slotName, {textAlign: 'center'}]} floorScale={0.75} text={m.name.split(' ')[0]} />
                    </View>
                  );
                }
                return (
                  <TouchableOpacity key={i} style={styles.slot} activeOpacity={0.7} onPress={handleAddMember}>
                    <View style={styles.slotEmpty}><Icon name="plus" size={18} color={T.textFaint} /></View>
                    <Text style={styles.slotIdx}>0{i + 1}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        {/* member detail rows (pending + active with limits/remove) */}
        {!loading && members.length > 0 && (
          <View style={styles.detailCard}>
            {members.map((m, i) => (
              <View key={m.id} style={[styles.memberRow, i < members.length - 1 && styles.memberRowBorder]}>
                <View style={styles.memberAvatar}><Text style={styles.memberAvatarText}>{initialsOf(m.name)}</Text></View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={styles.memberName} numberOfLines={1}>{m.name}</Text>
                  <Text style={styles.memberRole}>
                    {m.status === 'pending' ? 'Invite pending'
                      : m.spendLimit !== null ? `Limit ${m.spendLimit} cr · spent ${m.spent}`
                      : 'Shared credits'}
                  </Text>
                </View>
                {m.status === 'pending' ? (
                  <View style={[styles.badge, {backgroundColor: 'rgba(245,181,68,0.12)', borderColor: 'rgba(245,181,68,0.3)'}]}>
                    <Text style={[styles.badgeText, {color: '#F5B544'}]}>PENDING</Text>
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => removeMember(m.id)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}} activeOpacity={0.7}>
                    <Icon name="close-circle-outline" size={20} color={T.textMute} />
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </View>
        )}

        {/* empty invite CTA */}
        {!loading && members.length === 0 && (
          <View style={styles.emptyCard}>
      <ImageryBackdrop source={Imagery.authClientApp} variant="card" radius={20} />
            <View style={styles.emptyIcon}><Icon name="account-multiple-plus-outline" size={26} color={T.blue} /></View>
            <Text style={styles.emptyTitle}>No family members yet</Text>
            <Text style={styles.emptySub}>Invite up to {MAX_SEATS} people — they can spend from your Bravo Credits once they accept.</Text>
            <TouchableOpacity activeOpacity={0.85} onPress={handleAddMember} style={{width: '100%', marginTop: 20}}>
              <LinearGradient colors={['#6E9BF5', T.accent, T.accentDeep]} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={styles.emptyBtn}>
                <Icon name="account-plus-outline" size={17} color="#fff" />
                <Text style={styles.emptyBtnText}>Invite a member</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Credit usage ── */}
        {usage && usage.members.length > 0 && (
          <View style={styles.usageCard}>
            <View style={styles.usageHeader}>
              <Text style={styles.sectionLabelInline}>Credit Usage</Text>
              <Text style={styles.usageTotal}>{usage.totalSpent.toLocaleString()} BC total</Text>
            </View>
            {usage.members.map((m, i) => {
              const c = USAGE_COLORS[i % USAGE_COLORS.length];
              const denom = m.spendLimit ?? (usage.totalSpent || 1);
              const pct = Math.min(100, Math.round((m.spent / Math.max(denom, 1)) * 100));
              return (
                <View key={m.id} style={styles.usageRow}>
                  <View style={styles.usageRowTop}>
                    <Text style={styles.usageName}>{m.name}</Text>
                    <Text style={styles.usageVal}>
                      {m.spent.toLocaleString()}{m.spendLimit !== null ? ` / ${m.spendLimit.toLocaleString()}` : ''} BC
                      <Text style={styles.usageShare}>  ·  {m.sharePct}%</Text>
                    </Text>
                  </View>
                  <View style={styles.usageTrack}>
                    <View style={[styles.usageFill, {width: `${pct}%`, backgroundColor: c}]} />
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* shared-credits note */}
        <View style={styles.note}>
          <Icon name="information-outline" size={16} color={T.textMute} style={{marginTop: 1}} />
          <Text style={styles.noteText}>Family members share your wallet balance. You stay in control and can remove anyone at any time.</Text>
        </View>

        {showInviteToast && (
          <View style={styles.toast}><Text style={styles.toastText}>{toastMsg}</Text></View>
        )}
      </ScrollView>

      {/* Invite modal */}
      <Modal visible={inviteOpen} transparent animationType="fade" onRequestClose={() => setInviteOpen(false)}>
        {/* B-184 — one rule, both platforms: the backdrop shrinks by the IME
            overlap so the centered card re-centres above the keyboard. */}
        <View style={[styles.modalOverlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Invite family member</Text>
            <Text style={styles.modalSub}>They can spend your Bravo Credits once they accept.</Text>
            <TextInput
              style={styles.modalInput}
              value={phone}
              onChangeText={t => { setPhone(t); setErr(null); }}
              placeholder="+971 50 123 4567"
              placeholderTextColor={T.textMute}
              keyboardType="phone-pad"
              autoFocus
            />
            <TextInput
              style={styles.modalInput}
              value={limit}
              onChangeText={t => { setLimit(t); setErr(null); }}
              placeholder="Spend limit (credits) — optional"
              placeholderTextColor={T.textMute}
              keyboardType="number-pad"
            />
            {err && <Text style={styles.modalErr}>{err}</Text>}
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setInviteOpen(false)} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSend, (!phone.trim() || busy) && {opacity: 0.4}]}
                disabled={!phone.trim() || busy}
                onPress={() => { void submitInvite(); }}
                activeOpacity={0.85}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalSendText}>Invite</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: T.bg},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10},
  back: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontFamily: BravoFont.bold, fontSize: 17, letterSpacing: -0.3, color: T.text, textAlign: 'center'},
  headerSub: {fontFamily: BravoFont.regular, fontSize: 11, color: T.textMute, textAlign: 'center', marginTop: 1},

  content: {paddingHorizontal: 20, paddingTop: 8, gap: 18},

  idCard: {position: 'relative', overflow: 'hidden', borderRadius: 22, padding: 20, borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)'},
  idGlow: {position: 'absolute', top: -50, right: -40, width: 180, height: 180, borderRadius: 90, backgroundColor: 'rgba(91,141,239,0.1)'},
  idRow: {flexDirection: 'row', alignItems: 'center', gap: 16},
  idAvatar: {width: 70, height: 70, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},
  idAvatarImg: {width: 70, height: 70, borderRadius: 20},
  idAvatarText: {fontFamily: BravoFont.extraBold, fontSize: 30, color: '#fff'},
  idName: {fontFamily: BravoFont.extraBold, fontSize: 23, letterSpacing: -0.5, color: T.text},
  idBadges: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 9},
  badge: {paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1},
  badgeText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1},

  sectionHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: -8, marginLeft: 4},
  sectionLabel: {fontFamily: BravoFont.semiBold, fontSize: 10.5, letterSpacing: 1.5, color: T.textMute, textTransform: 'uppercase'},
  sectionLabelInline: {fontFamily: BravoFont.semiBold, fontSize: 10.5, letterSpacing: 1.5, color: T.textMute, textTransform: 'uppercase'},
  addBtn: {width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},

  membersCard: {borderRadius: 20, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2, overflow: 'hidden'},
  meterWrap: {padding: 16, borderBottomWidth: 1, borderBottomColor: T.hair},
  meterRow: {flexDirection: 'row', gap: 6},
  meterBar: {flex: 1, height: 5, borderRadius: 3},
  meterLabelRow: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 10},
  meterUsed: {fontFamily: BravoFont.regular, fontSize: 12.5, color: T.textDim},
  meterAvail: {fontFamily: BravoFont.mono, fontSize: 10.5, letterSpacing: 0.4, color: T.blue},
  slotRow: {flexDirection: 'row', gap: 8, paddingVertical: 20, paddingHorizontal: 14},
  slot: {flex: 1, alignItems: 'center', gap: 8},
  slotAvatar: {width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.18)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.22)'},
  slotAvatarText: {fontFamily: BravoFont.extraBold, fontSize: 18, color: T.text},
  slotName: {fontFamily: BravoFont.semiBold, fontSize: 10.5, color: T.textDim},
  slotEmpty: {width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: T.hair2, borderStyle: 'dashed', backgroundColor: 'rgba(255,255,255,0.015)'},
  slotIdx: {fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 0.5, color: T.textFaint},

  detailCard: {borderRadius: 18, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2, overflow: 'hidden'},
  memberRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12},
  memberRowBorder: {borderBottomWidth: 1, borderBottomColor: T.hair},
  memberAvatar: {width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.15)'},
  memberAvatarText: {fontFamily: BravoFont.bold, fontSize: 13, color: T.blue},
  memberName: {fontFamily: BravoFont.bold, fontSize: 13.5, color: T.text},
  memberRole: {fontFamily: BravoFont.regular, fontSize: 11, color: T.textMute, marginTop: 1},

  emptyCard: {alignItems: 'center', borderRadius: 20, padding: 26, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair},
  emptyIcon: {width: 60, height: 60, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)', marginBottom: 16},
  emptyTitle: {fontFamily: BravoFont.bold, fontSize: 18, letterSpacing: -0.3, color: T.text},
  emptySub: {fontFamily: BravoFont.regular, fontSize: 13, lineHeight: 20, color: T.textDim, textAlign: 'center', marginTop: 8, paddingHorizontal: 10},
  emptyBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, height: 50, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  emptyBtnText: {fontFamily: BravoFont.bold, fontSize: 15, color: '#fff'},

  usageCard: {borderRadius: 18, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2, padding: 16, gap: 12},
  usageHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  usageTotal: {fontFamily: BravoFont.bold, fontSize: 12, color: T.text},
  usageRow: {gap: 6},
  usageRowTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  usageName: {fontFamily: BravoFont.bold, fontSize: 12, color: T.text},
  usageVal: {fontFamily: BravoFont.regular, fontSize: 11, color: T.textDim},
  usageShare: {color: T.textMute},
  usageTrack: {height: 7, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.05)', overflow: 'hidden'},
  usageFill: {height: '100%', borderRadius: 99},

  note: {flexDirection: 'row', alignItems: 'flex-start', gap: 11, paddingHorizontal: 4},
  noteText: {flex: 1, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 17, color: T.textMute},

  toast: {borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)'},
  toastText: {fontFamily: BravoFont.semiBold, fontSize: 12, color: T.blue},

  modalOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24},
  modalCard: {width: '100%', backgroundColor: '#11151D', borderRadius: 20, borderWidth: 1, borderColor: T.hair2, padding: 22},
  modalTitle: {fontFamily: BravoFont.extraBold, fontSize: 17, letterSpacing: -0.3, color: T.text},
  modalSub: {fontFamily: BravoFont.regular, fontSize: 12, color: T.textMute, marginTop: 5},
  modalInput: {marginTop: 14, height: 50, borderRadius: 13, paddingHorizontal: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: T.hair2, fontFamily: BravoFont.semiBold, fontSize: 15, color: T.text},
  modalErr: {fontFamily: BravoFont.semiBold, fontSize: 11.5, color: T.alert, marginTop: 8},
  modalRow: {flexDirection: 'row', gap: 12, marginTop: 18},
  modalCancel: {flex: 1, height: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.hair2, backgroundColor: 'rgba(255,255,255,0.05)'},
  modalCancelText: {fontFamily: BravoFont.bold, fontSize: 14, color: T.textDim},
  modalSend: {flex: 1, height: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: T.accent},
  modalSendText: {fontFamily: BravoFont.bold, fontSize: 14, color: '#fff'},
});
