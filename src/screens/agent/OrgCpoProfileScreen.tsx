/**
 * Provider · Officer Profile — everything the agency knows about one roster CPO.
 *
 * Reached by tapping a roster row (previously went straight to the bare mission
 * log). One server round-trip: GET /org/cpos/:id/profile is org-scoped and
 * IDOR-gated. Obsidian + platinum-cobalt to match OrgRoster.
 *
 * The avatar is READ-ONLY here — only the officer changes their own photo
 * (useAvatarPicker on their own "Me" tab). Agency-side upload would need a new
 * privileged path and is deliberately not offered.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  StatusBar, RefreshControl,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {orgApi, type OrgMemberProfile} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {warnStrandedClaims} from '@utils/strandedClaimsAlert';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type Rt = RouteProp<AgentStackParamList, 'OrgCpoProfile'>;

const D = {
  bg: '#07090D', card: '#11151D', text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)', hair: 'rgba(255,255,255,0.07)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', amber: '#F5C76B',
  signal: '#4ADE80', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold',
  fBold: 'Manrope_700Bold', fMono: 'monospace',
};

function initials(name: string | null): string {
  if (!name) {return 'OF';}
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) {return 'OF';}
  if (p.length === 1) {return p[0].slice(0, 2).toUpperCase();}
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

function fmtDate(iso: string | null): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});
}

function fmtKm(m: number): string {
  return m > 0 ? `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km` : '—';
}

function fmtDuration(s: number): string {
  if (s <= 0) {return '—';}
  const h = Math.floor(s / 3600);
  const min = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${min}m` : `${min}m`;
}

/**
 * Issue 39 — capability tokens are stored as raw keys ('firearms',
 * 'medical_frec3'). Render the human label; an unknown key falls back to a
 * de-underscored form rather than being dropped, so a capability added later
 * still shows up instead of silently vanishing from a compliance view.
 */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  firearms:         'Firearms certified',
  driving:          'Defensive driving L2',
  recon:            'Route recon / SIGINT',
  medical_first_aid:'First aid / trauma care',
  medical_frec3:    'FREC 3',
  medical_paramedic:'Paramedic or higher',
  // Legacy keys, pre Issue 36.
  first_aid:        'First aid / trauma care',
  medical:          'FREC 3',
};

function capabilityLabels(caps: string[] | undefined): string[] {
  return (caps ?? []).map(c => CAPABILITY_LABELS[c] ?? c.replace(/_/g, ' '));
}

function Stat({value, label}: {value: string | number; label: string}) {
  return (
    <View style={s.stat}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function Row({icon, label, value, tone}: {
  icon: React.ComponentProps<typeof Icon>['name']; label: string; value: string;
  tone?: 'alert' | 'warn';
}) {
  return (
    <View style={s.infoRow}>
      <Icon name={icon} size={15} color={tone === 'alert' ? D.alert : tone === 'warn' ? D.amber : D.textMute} />
      <Text style={s.infoLabel}>{label}</Text>
      <Text
        style={[s.infoValue, tone === 'alert' && {color: D.alert}, tone === 'warn' && {color: D.amber}]}
        numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Issue 39 — a qualification's validity state.
 *
 * NULL expiry is "none recorded", NEVER expired: most existing rows predate the
 * expiry column, and painting them red would tell a provider their whole roster
 * had lapsed overnight.
 */
const EXPIRY_WARN_DAYS = 30;

function expiryState(expiresAt: string | null | undefined): {
  label: string; tone?: 'alert' | 'warn';
} {
  if (!expiresAt) {return {label: 'no expiry recorded'};}
  const ms = new Date(expiresAt).getTime();
  if (!Number.isFinite(ms)) {return {label: 'no expiry recorded'};}
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  if (days < 0) {return {label: `EXPIRED ${fmtDate(expiresAt)}`, tone: 'alert'};}
  if (days <= EXPIRY_WARN_DAYS) {
    return {label: `expires ${fmtDate(expiresAt)} · ${days}d`, tone: 'warn'};
  }
  return {label: `valid to ${fmtDate(expiresAt)}`};
}

export default function OrgCpoProfileScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Rt>();
  const {memberUserId, displayName} = params;

  const [p, setP] = useState<OrgMemberProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const {data} = await orgApi.getMemberProfile(memberUserId);
      setP(data);
    } catch (e: unknown) {
      // Surface the server's reason (e.g. not_your_org_member — this person
      // left/was removed from the org) instead of a raw "Request failed with
      // status code 403" axios message.
      const serverMsg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      const friendly = serverMsg === 'not_your_org_member'
        ? 'This person is no longer part of your organization.'
        : serverMsg ?? 'Could not load this officer.';
      setError(friendly);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [memberUserId]);

  useEffect(() => { void load(); }, [load]);

  const liftSuspension = useCallback(() => {
    Alert.alert('Lift suspension?',
      `${p?.display_name ?? 'This officer'} regains access immediately and becomes assignable to missions.`, [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Lift',
          onPress: () => void (async () => {
            try {
              const {data} = await orgApi.setCpoStatus(memberUserId, 'active');
              warnStrandedClaims(data.stranded_room_claims);
              await load();
            } catch (e) {
              Alert.alert('Error', e instanceof Error ? e.message : 'Update failed');
            }
          })(),
        },
      ]);
  }, [p, memberUserId, load]);

  const suspended = p?.status === 'suspended';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => goBackOnce(navigation)} style={s.backBtn} activeOpacity={0.7}>
          <Icon name="chevron-left" size={26} color={D.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>
          {p?.display_name ?? displayName ?? 'Officer'}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{padding: 20, paddingBottom: insets.bottom + 28, gap: 16}}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} tintColor={D.accent}
            onRefresh={() => { setRefreshing(true); void load(); }} />
        }>

        {loading ? (
          <LoadingView compact label="Loading profile…" />
        ) : error || !p ? (
          <Text style={s.empty}>{error ?? 'Not found.'}</Text>
        ) : (
          <>
            {/* ── Hero ── */}
            <View style={s.hero}>
              <View style={s.avatarWrap}>
                {p.avatar_url ? (
                  <Image source={{uri: p.avatar_url}} style={s.avatarImg} />
                ) : (
                  <View style={s.avatarFallback}>
                    <Text style={s.avatarInitials}>{initials(p.display_name)}</Text>
                  </View>
                )}
                {p.on_duty && <View style={s.dutyDot} />}
              </View>
              <Text style={s.heroName} numberOfLines={1}>{p.display_name ?? '—'}</Text>
              <Text style={s.heroMeta}>
                {p.call_sign ? `${p.call_sign} · ` : ''}
                {p.member_role === 'owner' ? 'Owner'
                  : p.member_role === 'manager' ? 'Manager'
                  : p.member_role === 'employee' ? 'Employee' : 'CPO'}
              </Text>
              <View style={s.badgeRow}>
                <View style={[s.badge, suspended ? s.badgeAmber : s.badgeGreen]}>
                  <Text style={[s.badgeText, {color: suspended ? D.amber : D.signal}]}>
                    {p.status.toUpperCase()}
                  </Text>
                </View>
                {p.on_mission && (
                  <View style={[s.badge, s.badgeBlue]}>
                    <Text style={[s.badgeText, {color: D.accentSoft}]}>DEPLOYED</Text>
                  </View>
                )}
              </View>
            </View>

            {/* ── Suspension banner ── */}
            {suspended && (
              <View style={s.suspendCard}>
                <View style={s.suspendHead}>
                  <Icon name="account-clock-outline" size={18} color={D.amber} />
                  <Text style={s.suspendTitle}>Suspended</Text>
                </View>
                <Text style={s.suspendReason}>{p.suspend_reason ?? 'No reason recorded.'}</Text>
                <Text style={s.suspendMeta}>
                  {fmtDate(p.suspended_from)} → {p.suspended_until ? fmtDate(p.suspended_until) : 'no end date'}
                  {p.suspended_by_name ? ` · by ${p.suspended_by_name}` : ''}
                </Text>
                <TouchableOpacity style={s.liftBtn} onPress={liftSuspension} activeOpacity={0.85}>
                  <Icon name="lock-open-variant-outline" size={15} color={D.accentSoft} />
                  <Text style={s.liftText}>Lift suspension</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── Stats — the owner is the org, not roster crew: no mission_crew
                rows to aggregate, so this section (and Compliance/History below,
                which hit the same org_members-scoped endpoints) don't apply. */}
            {p.member_role !== 'owner' && (
              <>
                <Text style={s.sectionLabel}>MISSION RECORD</Text>
                <View style={s.statGrid}>
                  <Stat value={p.stats.missions_completed} label="COMPLETED" />
                  <Stat value={p.stats.missions_led} label="LED" />
                  <Stat value={p.stats.missions_aborted} label="ABORTED" />
                </View>
                <View style={s.statGrid}>
                  <Stat value={fmtKm(p.stats.total_distance_m)} label="DISTANCE" />
                  <Stat value={fmtDuration(p.stats.total_duration_s)} label="ON TASK" />
                  <Stat value={p.stats.credits_earned.toLocaleString()} label="CREDITS" />
                </View>
              </>
            )}

            {/* ── Identity ── */}
            <Text style={s.sectionLabel}>IDENTITY & CONTACT</Text>
            <View style={s.card}>
              <Row icon="email-outline" label="Email" value={p.email ?? '—'} />
              <Row icon="phone-outline" label="Phone" value={p.phone_e164 ?? '—'} />
              <Row icon="calendar-account-outline" label="Member since" value={fmtDate(p.created_at)} />
            </View>

            {p.member_role !== 'owner' && (
              <>
                {/* ── Compliance ── */}
                <Text style={s.sectionLabel}>COMPLIANCE</Text>
                <View style={s.card}>
                  <Row icon="shield-check-outline" label="Approval" value={p.agent_status ?? '—'} />
                  <Row
                    icon="pistol"
                    label="Armed authorised"
                    value={p.armed_authorized
                      ? `Yes · ${expiryState(p.armed_expires_at).label}`
                      : 'No'}
                    tone={p.armed_authorized ? expiryState(p.armed_expires_at).tone : undefined} />
                  <Row icon="run-fast" label="Duty state"
                    value={p.on_mission ? 'On mission' : p.on_duty ? 'On duty' : 'Off duty'} />
                  {/* Issue 39 — rating and qualifications were already stored on
                      `agents` but never shown to the provider, so the roster gave
                      no basis for deciding who to assign. "Not yet rated" rather
                      than a fake 0.0, which would read as a bad officer. */}
                  <Row icon="star-outline" label="Rating"
                    value={typeof p.rating === 'number' ? `${p.rating.toFixed(2)} / 5` : 'Not yet rated'} />
                  <Row icon="certificate-outline" label="Qualifications"
                    value={capabilityLabels(p.capabilities).join(', ') || 'None recorded'} />
                </View>

                {/* Issue 39 — the PDF asks for qualifications WITH EXPIRY. A
                    capability tag alone says an officer once held a
                    certificate, not that it is still valid; a provider
                    deciding who to deploy needs the difference. */}
                {(p.qualifications?.length ?? 0) > 0 && (
                  <>
                    <Text style={s.sectionLabel}>CERTIFICATIONS</Text>
                    <View style={s.card}>
                      {p.qualifications!.map(q => {
                        const st = expiryState(q.expires_at);
                        return (
                          <Row
                            key={q.slot}
                            icon="file-certificate-outline"
                            label={q.title || q.slot}
                            value={q.issuing_body ? `${st.label} · ${q.issuing_body}` : st.label}
                            tone={st.tone} />
                        );
                      })}
                    </View>
                  </>
                )}

                {/* ── History ── */}
                <TouchableOpacity
                  style={s.historyBtn}
                  activeOpacity={0.85}
                  onPress={() => navigation.navigate('OrgCpoMissions', {
                    memberUserId, displayName: p.display_name,
                  })}>
                  <Icon name="history" size={17} color={D.accentSoft} />
                  <Text style={s.historyText}>
                    Mission history ({p.stats.missions_total})
                  </Text>
                  <Icon name="chevron-right" size={19} color={D.textMute} />
                </TouchableOpacity>
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: D.hair,
  },
  backBtn: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 18, color: D.text, letterSpacing: -0.3},
  empty: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, textAlign: 'center', marginTop: 40},

  hero: {alignItems: 'center', gap: 6, paddingTop: 4},
  avatarWrap: {width: 92, height: 92, marginBottom: 6},
  avatarImg: {width: 92, height: 92, borderRadius: 46, borderWidth: 2, borderColor: 'rgba(91,141,239,0.35)'},
  avatarFallback: {
    width: 92, height: 92, borderRadius: 46, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 2, borderColor: 'rgba(91,141,239,0.35)',
  },
  avatarInitials: {fontFamily: D.fBold, fontSize: 30, color: D.accentSoft},
  dutyDot: {
    position: 'absolute', right: 4, bottom: 4, width: 18, height: 18, borderRadius: 9,
    backgroundColor: D.signal, borderWidth: 3, borderColor: D.bg,
  },
  heroName: {fontFamily: D.fBold, fontSize: 21, color: D.text, letterSpacing: -0.4},
  heroMeta: {fontFamily: D.fMono, fontSize: 11.5, color: D.textMute, letterSpacing: 0.4},
  badgeRow: {flexDirection: 'row', gap: 8, marginTop: 6},
  badge: {paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, borderWidth: 1},
  badgeGreen: {backgroundColor: 'rgba(74,222,128,0.10)', borderColor: 'rgba(74,222,128,0.32)'},
  badgeAmber: {backgroundColor: 'rgba(245,199,107,0.10)', borderColor: 'rgba(245,199,107,0.34)'},
  badgeBlue: {backgroundColor: 'rgba(91,141,239,0.12)', borderColor: 'rgba(91,141,239,0.34)'},
  badgeText: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 1},

  suspendCard: {
    backgroundColor: 'rgba(245,199,107,0.07)', borderRadius: 16, padding: 14, gap: 8,
    borderWidth: 1, borderColor: 'rgba(245,199,107,0.28)',
  },
  suspendHead: {flexDirection: 'row', alignItems: 'center', gap: 8},
  suspendTitle: {fontFamily: D.fBold, fontSize: 13, color: D.amber, letterSpacing: 0.4},
  suspendReason: {fontFamily: D.fSans, fontSize: 13.5, color: D.text, lineHeight: 19},
  suspendMeta: {fontFamily: D.fMono, fontSize: 10.5, color: D.textMute, letterSpacing: 0.3},
  liftBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 4, paddingVertical: 11, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.30)', backgroundColor: 'rgba(91,141,239,0.10)',
  },
  liftText: {fontFamily: D.fBold, fontSize: 12.5, color: D.accentSoft, letterSpacing: 0.3},

  sectionLabel: {
    fontFamily: D.fBold, fontSize: 10, color: D.textFaint,
    letterSpacing: 1.4, marginBottom: -6, marginTop: 2,
  },
  statGrid: {flexDirection: 'row', gap: 10},
  stat: {
    flex: 1, backgroundColor: D.card, borderRadius: 14, paddingVertical: 14,
    alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: D.hair,
  },
  statValue: {fontFamily: D.fBold, fontSize: 17, color: D.text},
  statLabel: {fontFamily: D.fMono, fontSize: 8.5, color: D.textMute, letterSpacing: 0.8, marginTop: 3},

  card: {
    backgroundColor: D.card, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 4,
    borderWidth: StyleSheet.hairlineWidth, borderColor: D.hair,
  },
  infoRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11},
  infoLabel: {fontFamily: D.fSans, fontSize: 12.5, color: D.textDim, width: 104},
  infoValue: {flex: 1, fontFamily: D.fSemi, fontSize: 12.5, color: D.text, textAlign: 'right'},

  historyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: D.card, borderRadius: 16, padding: 15,
    borderWidth: StyleSheet.hairlineWidth, borderColor: D.hair,
  },
  historyText: {flex: 1, fontFamily: D.fSemi, fontSize: 13.5, color: D.text},
}));
