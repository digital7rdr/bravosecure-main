/**
 * Bravo Secure Pro — Linked Members (mock page 15's management half).
 *
 * Owner adds members from their phone contacts (messenger-style: contacts
 * matched against registered Bravo accounts — members MUST already hold an
 * individual account). Each member carries an owner-declared relationship
 * (badge on the right), can spend the owner's credits up to a limit, and can
 * be put on hold for a period or removed. Active members ride the owner's
 * Pro plan (dashboard access + owner-paid bookings tagged "under the owner").
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, TextInput,
  Modal, Pressable, ActivityIndicator, Image, FlatList, Linking, Platform,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {useProPlanGate} from '@hooks/useProPlanGate';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {UsersHttpClient} from '@bravo/messenger-core';
import {useDiscoveredContacts, type DiscoveredRow} from '@/modules/messenger/contacts/useDiscoveredContacts';
import {filterContacts} from '@/modules/messenger/contacts/contactSearch';
import {familyApi, tokenStore, type FamilyCreditRequest, type FamilyMember, type FamilyMemberLocation, type FamilyMemberSpend} from '@services/api';
import {quotaFloorFrom} from '@screens/booking/creditErrors';
import {buildPinMapUrl} from '@/modules/news/mapbox';
import {API_BASE_URL} from '@utils/constants';
import {useAuthStore} from '@store/authStore';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureProMembers'>;

const MAX_SEATS = 4;

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
  signal:     '#4ADE80',
  amber:      '#F5C76B',
  alert:      '#FF5D5D',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

const RELATIONSHIPS = ['Spouse', 'Father', 'Mother', 'Son', 'Daughter', 'Brother', 'Sister', 'Guardian', 'Other'] as const;

const INVITE_ERRORS: Record<string, string> = {
  not_a_bravo_user: 'They need their own Bravo Secure account first (Lite or Pro).',
  not_an_individual_account: 'Only individual accounts can join a family.',
  family_full: `Your family is full (${MAX_SEATS} members max).`,
  member_in_another_family: 'They are already part of another family.',
  invite_already_pending: 'You already invited this person.',
  cannot_invite_self: "That's your own number.",
};

function initials(name: string): string {
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'M';
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short'});
}

function isHeld(m: FamilyMember): boolean {
  return !!m.heldUntil && new Date(m.heldUntil).getTime() > Date.now();
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) {return 'just now';}
  const m = Math.floor(ms / 60_000);
  if (m < 60) {return `${m}m ago`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h ago`;}
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : fmtDate(iso);
}

function featureLabel(f: string | null): string {
  if (!f) {return 'Other';}
  if (f === 'booking') {return 'Protection booking';}
  if (f === 'secure_pro_plan' || f === 'pro_application') {return 'Secure Pro plan';}
  if (f === 'messenger_plan' || f.endsWith('_subscription')) {return 'Messenger plan';}
  return f.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

function locationLine(loc: FamilyMemberLocation): string {
  const place = loc.label ?? `${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}`;
  return `${place} · ${timeAgo(loc.recordedAt)}`;
}

function openInMaps(loc: FamilyMemberLocation, name: string): void {
  const ll = `${loc.lat},${loc.lng}`;
  // geo: pin labels break on parentheses even when percent-encoded.
  const label = encodeURIComponent(name.replace(/[()]/g, ''));
  const url = Platform.OS === 'android'
    ? `geo:${ll}?q=${ll}(${label})`
    : `https://maps.apple.com/?ll=${ll}&q=${label}`;
  void Linking.openURL(url).catch(() => {});
}

export default function SecureProMembersScreen() {
  useProPlanGate(); // Audit Rev2 SP-01 — activation gate (see the hook)
  const insets = useSafeAreaInsets();
  const {contentBottom, bottomPad} = useBottomInset();
  // Why: both modals sit under edge-to-edge — their bottom-most element owns
  // the inset (nav bar when the IME is closed, keyboard when it is up).
  const {bottomPad: kbBottomPad} = useKeyboardLayout();
  const navigation = useNavigation<Nav>();
  const user = useAuthStore(s => s.user);

  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // At the 4/4 cap the "Add Member" CTA becomes a "Request additional seats"
  // action that files an Ops request (self-serve add stays hard-capped).
  const [seatRequestState, setSeatRequestState] = useState<'idle' | 'sending' | 'sent'>('idle');

  // Add flow
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<DiscoveredRow | null>(null);
  const [query, setQuery] = useState('');
  const [relationship, setRelationship] = useState<string | null>(null);
  const [limitText, setLimitText] = useState('');

  // Spec §43 — open credit requests awaiting this holder's decision.
  const [requests, setRequests] = useState<FamilyCreditRequest[]>([]);

  // Manage sheet
  const [manage, setManage] = useState<FamilyMember | null>(null);
  const [manageLimit, setManageLimit] = useState('');
  const [spend, setSpend] = useState<FamilyMemberSpend | null>(null);
  const [spendLoading, setSpendLoading] = useState(false);
  const [spendError, setSpendError] = useState(false);
  const [spendNonce, setSpendNonce] = useState(0); // bump = retry

  // Spending breakdown loads when the sheet opens on an accepted member.
  useEffect(() => {
    setSpend(null);
    setSpendError(false);
    if (!manage || manage.status === 'pending') {return;}
    let stale = false;
    setSpendLoading(true);
    familyApi.memberSpend(manage.id)
      .then(({data}) => { if (!stale) {setSpend(data);} })
      .catch(() => { if (!stale) {setSpendError(true);} })
      .finally(() => { if (!stale) {setSpendLoading(false);} });
    return () => { stale = true; };
  }, [manage, spendNonce]);

  const managePinUrl = manage?.lastLocation
    ? buildPinMapUrl({lng: manage.lastLocation.lng, lat: manage.lastLocation.lat})
    : '';

  const load = useCallback(async () => {
    try {
      const {data} = await familyApi.members();
      setMembers(data.members);
    } catch {
      // keep last good list
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Spec §43 — pending credit requests belong on the root dashboard.
   *
   * Fetched separately from `members` so a request-endpoint failure cannot
   * blank the member list, and re-fetched on focus: a member may have filed one
   * from their own device while this screen sat in the background (§47).
   */
  const loadRequests = useCallback(async () => {
    try {
      const {data} = await familyApi.creditRequests();
      setRequests(data.requests.filter(r => r.status === 'pending'));
    } catch {
      // keep last good list — a missing request panel must not break the screen
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
    void loadRequests();
  }, [load, loadRequests]));

  const usersClient = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );
  const contacts = useDiscoveredContacts({
    users:        usersClient,
    ownPhoneE164: user?.phone_e164 ?? null,
    enabled:      pickerOpen,
  });
  const visibleMatches = useMemo(
    () => filterContacts(contacts.matches, query).filter(
      row => !members.some(m => m.memberId === row.userId && (m.status === 'active' || m.status === 'pending'))),
    [contacts.matches, query, members],
  );

  const activeCount = members.filter(m => m.status === 'active').length;
  const atCap = activeCount >= MAX_SEATS;

  // Escape hatch at the cap: file an Ops request for more seats. Self-serve
  // `invite` still hard-caps at MAX_SEATS server-side, so this never mints a
  // 5th seat — it just asks Ops. The server call cannot fail loudly (the ops
  // emit is best-effort), so 'sent' is the confirmed terminal state.
  const requestSeats = async () => {
    if (seatRequestState !== 'idle') {return;}
    setSeatRequestState('sending');
    try {
      await familyApi.requestSeats();
      setSeatRequestState('sent');
      Alert.alert('Request sent', 'Ops will be in touch about adding more seats to your plan.');
    } catch {
      setSeatRequestState('idle');
      Alert.alert('Could not send request', 'Please try again.');
    }
  };

  const sendInvite = async () => {
    if (!picked || !relationship || busy) {return;}
    setBusy(true);
    try {
      const limit = limitText.trim() ? parseInt(limitText, 10) : null;
      await familyApi.invite(picked.phoneE164, Number.isFinite(limit as number) ? limit : null, relationship);
      setPickerOpen(false);
      setPicked(null); setRelationship(null); setLimitText(''); setQuery('');
      await load();
      Alert.alert('Invite sent', 'They can accept it from their profile.');
    } catch (e) {
      const code = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Could not add member', INVITE_ERRORS[code ?? ''] ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const applyHold = async (m: FamilyMember, days: number | null) => {
    setBusy(true);
    try {
      const until = days === null ? null : new Date(Date.now() + days * 86400_000).toISOString();
      await familyApi.setHold(m.id, until);
      setManage(null);
      await load();
    } catch {
      Alert.alert('Could not update hold', 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const saveLimit = async (m: FamilyMember) => {
    setBusy(true);
    try {
      const parsed = manageLimit.trim() ? parseInt(manageLimit, 10) : null;
      await familyApi.setLimit(m.id, Number.isFinite(parsed as number) ? parsed : null);
      setManage(null);
      await load();
    } catch (e) {
      // Spec §19/§44 — a quota may never be reduced below what the member has
      // ALREADY spent; the server refuses it and returns the floor. Showing
      // "Please try again" here would send the holder round a loop that can
      // never succeed, so the real reason and the real minimum are surfaced.
      // The floor comes from the server, never from the row this screen is
      // holding, which may already be stale (§48).
      const floor = quotaFloorFrom(e);
      if (floor !== undefined) {
        Alert.alert(
          'Limit is below what they’ve spent',
          `${m.name} has already spent ${floor.toLocaleString()} credits, so their limit cannot go below that. `
          + 'Set it to that amount or higher.',
        );
      } else {
        Alert.alert('Could not save limit', 'Please try again.');
      }
      // Either way, re-read: the refusal usually means this screen's numbers
      // are behind the server's.
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  /**
   * Spec §13-§15 — decide a member's request for more credit.
   *
   * Approve adds to the quota server-side (under a lock, with an audit row);
   * this screen never computes the new limit itself. `approvedCredits` omitted
   * = approve in full — partial approval is offered as a separate prompt.
   */
  const decideRequest = async (
    req: FamilyCreditRequest, action: 'approve' | 'reject',
  ) => {
    setBusy(true);
    try {
      if (action === 'approve') {
        const res = await familyApi.approveCredit(req.id);
        Alert.alert(
          'Credit approved',
          `${req.memberName ?? 'Your member'}’s limit is now ${res.data.newLimit.toLocaleString()} credits.`,
        );
      } else {
        await familyApi.rejectCredit(req.id);
      }
      await loadRequests();
      await load();
    } catch (e) {
      // A request decided elsewhere (another device, or the member cancelled)
      // comes back REQUEST_NOT_PENDING — that is not an error to retry, it is a
      // stale screen. §47/§48: reconcile rather than insist.
      const raw = String((e as {response?: {data?: {message?: unknown}}})?.response?.data?.message ?? '');
      Alert.alert(
        raw.includes('request_not_pending') ? 'Already decided' : 'Could not update request',
        raw.includes('request_not_pending')
          ? 'This request was already handled. Refreshing.'
          : 'Please try again.',
      );
      await loadRequests().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const removeMember = (m: FamilyMember) => {
    Alert.alert(
      'Remove member?',
      `${m.name} will lose access to your plan and credits.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Remove', style: 'destructive', onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              await familyApi.remove(m.id);
              setManage(null);
              await load();
            } finally {
              setBusy(false);
            }
          })();
        }},
      ],
    );
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
          <Text style={s.headerTitle}>Linked Members</Text>
          <FitLine style={s.headerSub} text={`${activeCount} OF ${MAX_SEATS} SEATS · BRAVO SECURE PRO`} />
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(110)}}
        showsVerticalScrollIndicator={false}>

        {/* Spec §43 — pending credit requests, above the roster: they are the
            one thing on this screen that is WAITING on the holder. Rendered
            whatever the roster's loading state is, so a slow member list never
            hides a decision the member is blocked on. */}
        {requests.length > 0 && (
          <View style={{gap: 10, marginBottom: 16}}>
            <Text style={s.sectionLabel}>
              {requests.length === 1 ? 'CREDIT REQUEST' : `CREDIT REQUESTS · ${requests.length}`}
            </Text>
            {requests.map(r => (
              <View key={r.id} style={s.requestCard}>
                <View style={{flex: 1, minWidth: 0, gap: 3}}>
                  <Text style={s.requestName} numberOfLines={1}>
                    {r.memberName ?? 'Family member'}
                  </Text>
                  <Text style={s.requestAmount}>
                    Requested {r.requestedCredits.toLocaleString()} BC
                  </Text>
                  {!!r.reason && (
                    <Text style={s.requestReason} numberOfLines={2}>“{r.reason}”</Text>
                  )}
                </View>
                <View style={{flexDirection: 'row', gap: 8}}>
                  <TouchableOpacity
                    style={[s.requestBtn, s.requestBtnGhost]}
                    disabled={busy}
                    onPress={() => { void decideRequest(r, 'reject'); }}
                    accessibilityRole="button"
                    accessibilityLabel={`Reject ${r.memberName ?? 'member'}'s request for ${r.requestedCredits} credits`}>
                    <Text style={s.requestBtnGhostText}>Reject</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.requestBtn, s.requestBtnPrimary]}
                    disabled={busy}
                    onPress={() => { void decideRequest(r, 'approve'); }}
                    accessibilityRole="button"
                    accessibilityLabel={`Approve ${r.requestedCredits} credits for ${r.memberName ?? 'member'}`}>
                    <Text style={s.requestBtnPrimaryText}>Approve</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {loading ? (
          <View style={{paddingVertical: 48, alignItems: 'center'}}>
            <ActivityIndicator color={D.accent} />
          </View>
        ) : members.length === 0 ? (
          <View style={s.emptyCard}>
      <ImageryBackdrop source={Imagery.proLinkedMembers} variant="card" radius={18} />
            <Icon name="account-multiple-plus-outline" size={26} color={D.textMute} />
            <Text style={s.emptyTitle}>No linked members yet</Text>
            <Text style={s.emptySub}>
              Add family from your contacts — they use your plan and credits, under your control.
            </Text>
          </View>
        ) : (
          <View style={{gap: 10}}>
            {members.map(m => {
              const held = isHeld(m);
              return (
                <TouchableOpacity
                  key={m.id}
                  style={[s.memberCard, held && {opacity: 0.65}]}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={`Manage ${m.name}`}
                  onPress={() => { setManageLimit(m.spendLimit !== null ? String(m.spendLimit) : ''); setManage(m); }}>
                  <View style={s.avatar}>
                    {m.avatarUrl ? (
                      <Image source={{uri: m.avatarUrl}} style={s.avatarImg} />
                    ) : (
                      <Text style={s.avatarText}>{initials(m.name)}</Text>
                    )}
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.memberName} numberOfLines={1}>{m.name}</Text>
                    <Text style={s.memberSub} numberOfLines={1}>
                      {m.status === 'pending'
                        ? 'Invite pending'
                        : held
                          ? `On hold until ${fmtDate(m.heldUntil!)}`
                          : m.spendLimit !== null
                            ? `${m.spent.toLocaleString()} / ${m.spendLimit.toLocaleString()} BC used`
                            : `${m.spent.toLocaleString()} BC used · no limit`}
                    </Text>
                    {m.status === 'active' && !held && m.lastLocation ? (
                      <View style={s.memberLocRow}>
                        <Icon name="map-marker" size={11} color={D.accentSoft} importantForAccessibility="no" />
                        <Text style={s.memberLoc} numberOfLines={1}>{locationLine(m.lastLocation)}</Text>
                      </View>
                    ) : null}
                  </View>
                  {m.relationship ? (
                    <View style={s.relBadge}>
                      <Text style={s.relBadgeText} numberOfLines={1}>{m.relationship.toUpperCase()}</Text>
                    </View>
                  ) : null}
                  {m.status === 'pending' ? (
                    <View style={[s.statePill, {borderColor: 'rgba(245,199,107,0.4)', backgroundColor: 'rgba(245,199,107,0.1)'}]}>
                      <Text style={[s.statePillText, {color: D.amber}]}>PENDING</Text>
                    </View>
                  ) : held ? (
                    <View style={[s.statePill, {borderColor: 'rgba(255,93,93,0.4)', backgroundColor: 'rgba(255,93,93,0.08)'}]}>
                      <Text style={[s.statePillText, {color: D.alert}]}>HOLD</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <View style={s.noteCard}>
          <Icon name="shield-check" size={15} color={D.accentSoft} />
          <Text style={s.noteText}>
            Members need their own Bravo Secure account (Lite or Pro). Active members share your
            Pro dashboard, and their bookings are paid from your credits — capped by the limit
            you set and visibly marked as under your plan.
          </Text>
        </View>
      </ScrollView>

      {/* Bottom CTA — below cap: Add Member. At the 4/4 cap the dead "Family
          Full" button is replaced by an ACTIONABLE "Request additional seats"
          that files an Ops request (self-serve add stays hard-capped at 4). */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        {atCap ? (
          <>
            <TouchableOpacity
              activeOpacity={0.9}
              disabled={seatRequestState !== 'idle'}
              onPress={() => { void requestSeats(); }}
              accessibilityRole="button"
              accessibilityLabel={seatRequestState === 'sent' ? 'Seat request sent' : 'Request additional seats'}
              accessibilityState={{disabled: seatRequestState !== 'idle'}}>
              <LinearGradient
                colors={seatRequestState === 'sent'
                  ? ['rgba(74,222,128,0.16)', 'rgba(74,222,128,0.13)', 'rgba(74,222,128,0.10)']
                  : ['#6E9BF5', D.accent, D.accentDeep]}
                locations={[0, 0.55, 1]}
                start={{x: 0, y: 0}}
                end={{x: 0, y: 1}}
                style={[s.cta, seatRequestState === 'sent' && s.ctaSent]}>
                {seatRequestState === 'sending' ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Icon
                      name={seatRequestState === 'sent' ? 'check-circle-outline' : 'account-multiple-plus'}
                      size={18}
                      color={seatRequestState === 'sent' ? D.signal : '#fff'}
                      importantForAccessibility="no"
                    />
                    <Text style={[s.ctaText, seatRequestState === 'sent' && {color: D.signal}]}>
                      {seatRequestState === 'sent' ? 'Request sent — Ops will be in touch' : 'Request additional seats'}
                    </Text>
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>
            {seatRequestState === 'idle' && (
              <Text style={s.gateHint}>You're at the {MAX_SEATS}-seat limit — Ops can add more.</Text>
            )}
          </>
        ) : (
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => setPickerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Add member">
            <LinearGradient
              colors={['#6E9BF5', D.accent, D.accentDeep]}
              locations={[0, 0.55, 1]}
              start={{x: 0, y: 0}}
              end={{x: 0, y: 1}}
              style={s.cta}>
              <Icon name="account-plus" size={18} color="#fff" importantForAccessibility="no" />
              <Text style={s.ctaText}>Add Member</Text>
            </LinearGradient>
          </TouchableOpacity>
        )}
      </LinearGradient>

      {/* ── Add-member modal: contact picker → relationship → limit ── */}
      <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => { if (!busy) {setPickerOpen(false); setPicked(null);} }}>
        <View style={[s.root, {paddingTop: insets.top}]}>
          <View style={s.header}>
            <TouchableOpacity
              style={s.back}
              onPress={() => {
                if (busy) {return;}
                if (picked) {setPicked(null);} else {setPickerOpen(false); setQuery('');}
              }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Back">
              <Icon name="chevron-left" size={20} color={D.text} />
            </TouchableOpacity>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.headerTitle}>{picked ? 'Member Details' : 'Add From Contacts'}</Text>
              <FitLine style={s.headerSub} text={picked ? picked.phoneE164 : 'CONTACTS WITH A BRAVO SECURE ACCOUNT'} />
            </View>
          </View>

          {!picked ? (
            <>
              <View style={s.searchWrap}>
                <Icon name="magnify" size={17} color={D.textMute} />
                <TextInput
                  style={s.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search name or number…"
                  placeholderTextColor={D.textMute}
                  selectionColor={D.accent}
                />
              </View>
              {contacts.permission === 'denied' ? (
                <View style={s.centerFill}>
                  <Icon name="account-lock-outline" size={26} color={D.textMute} />
                  <Text style={s.emptyTitle}>Contacts permission needed</Text>
                  <Text style={s.emptySub}>Allow contact access in system settings to pick members.</Text>
                </View>
              ) : contacts.loading ? (
                <View style={s.centerFill}><ActivityIndicator color={D.accent} /></View>
              ) : visibleMatches.length === 0 ? (
                <View style={s.centerFill}>
                  <Icon name="account-search-outline" size={26} color={D.textMute} />
                  <Text style={s.emptyTitle}>No matches</Text>
                  <Text style={s.emptySub}>
                    Only contacts who already have a Bravo Secure account appear here.
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={visibleMatches}
                  keyExtractor={r => r.userId}
                  contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(24)}}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({item}) => (
                    <TouchableOpacity
                      style={s.contactRow}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={`Pick ${item.localName ?? item.displayName}`}
                      onPress={() => setPicked(item)}>
                      <View style={s.avatar}>
                        {item.avatarUrl ? (
                          <Image source={{uri: item.avatarUrl}} style={s.avatarImg} />
                        ) : (
                          <Text style={s.avatarText}>{initials(item.localName ?? item.displayName ?? 'M')}</Text>
                        )}
                      </View>
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.memberName} numberOfLines={1}>{item.localName ?? item.displayName}</Text>
                        <Text style={s.memberSub} numberOfLines={1}>{item.phoneE164}</Text>
                      </View>
                      <Icon name="chevron-right" size={20} color={D.textMute} />
                    </TouchableOpacity>
                  )}
                />
              )}
            </>
          ) : (
            <ScrollView
              style={{flex: 1}}
              contentContainerStyle={{paddingHorizontal: 20, paddingBottom: kbBottomPad(40)}}
              keyboardShouldPersistTaps="handled">
              <View style={s.pickedCard}>
                <View style={[s.avatar, {width: 52, height: 52, borderRadius: 26}]}>
                  {picked.avatarUrl ? (
                    <Image source={{uri: picked.avatarUrl}} style={{width: 52, height: 52, borderRadius: 26}} />
                  ) : (
                    <Text style={[s.avatarText, {fontSize: 16}]}>{initials(picked.localName ?? picked.displayName ?? 'M')}</Text>
                  )}
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={[s.memberName, {fontSize: 16}]} numberOfLines={1}>
                    {picked.localName ?? picked.displayName}
                  </Text>
                  <Text style={s.memberSub}>{picked.phoneE164}</Text>
                </View>
              </View>

              <Text style={s.sectionLabel}>RELATIONSHIP</Text>
              <View style={s.chipWrap}>
                {RELATIONSHIPS.map(r => {
                  const on = relationship === r;
                  return (
                    <TouchableOpacity
                      key={r}
                      style={[s.chip, on && s.chipOn]}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityState={{selected: on}}
                      onPress={() => setRelationship(r)}>
                      <Text style={[s.chipText, on && {color: D.text}]}>{r}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={s.sectionLabel}>SPEND LIMIT (OPTIONAL)</Text>
              <TextInput
                style={s.input}
                value={limitText}
                onChangeText={t => setLimitText(t.replace(/[^\d]/g, ''))}
                placeholder="Max BC they can spend from your wallet — empty = no limit"
                placeholderTextColor={D.textMute}
                selectionColor={D.accent}
                keyboardType="number-pad"
                maxLength={7}
              />

              <TouchableOpacity
                style={{marginTop: 24}}
                activeOpacity={0.9}
                disabled={!relationship || busy}
                onPress={() => { void sendInvite(); }}
                accessibilityRole="button"
                accessibilityLabel="Send invite"
                accessibilityState={{disabled: !relationship || busy}}>
                <LinearGradient
                  colors={!relationship
                    ? ['rgba(91,141,239,0.35)', 'rgba(91,141,239,0.35)', 'rgba(47,91,224,0.35)']
                    : ['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.cta}>
                  {busy ? <ActivityIndicator color="#fff" /> : (
                    <>
                      <Icon name="send" size={17} color="#fff" importantForAccessibility="no" />
                      <Text style={s.ctaText}>Send Invite</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
              {!relationship && (
                <Text style={s.gateHint}>Pick the relationship — it shows on their member badge.</Text>
              )}
            </ScrollView>
          )}
        </View>
      </Modal>

      {/* ── Manage sheet ── */}
      <Modal visible={!!manage} transparent animationType="slide" onRequestClose={() => { if (!busy) {setManage(null);} }}>
        <Pressable style={s.sheetBackdrop} onPress={() => { if (!busy) {setManage(null);} }}>
          <Pressable style={[s.sheetCard, {paddingBottom: kbBottomPad(24)}]} onPress={() => {}}>
            {manage && (
              <ScrollView
                showsVerticalScrollIndicator={false}
                bounces={false}
                keyboardShouldPersistTaps="handled">
                <View style={{flexDirection: 'row', alignItems: 'center', gap: 12}}>
                  <Text style={[s.sheetTitle, {flex: 1, minWidth: 0}]} numberOfLines={1}>{manage.name}</Text>
                  {manage.relationship ? (
                    <View style={s.relBadge}>
                      <Text style={s.relBadgeText}>{manage.relationship.toUpperCase()}</Text>
                    </View>
                  ) : null}
                </View>

                {manage.status === 'active' && !isHeld(manage) && (
                  <>
                    <Text style={s.sectionLabel}>LAST LOCATION</Text>
                    {manage.lastLocation ? (
                      <View style={s.locCard}>
                        {managePinUrl ? (
                          <Image
                            source={{uri: managePinUrl}}
                            style={s.locMap}
                            resizeMode="cover"
                            accessibilityLabel={`Map of ${manage.name}'s last location`}
                          />
                        ) : null}
                        <View style={s.locMetaRow}>
                          <View style={{flex: 1, minWidth: 0}}>
                            <Text style={s.locPlace} numberOfLines={1}>
                              {manage.lastLocation.label
                                ?? `${manage.lastLocation.lat.toFixed(4)}, ${manage.lastLocation.lng.toFixed(4)}`}
                            </Text>
                            <Text style={s.locTime}>Updated {timeAgo(manage.lastLocation.recordedAt)}</Text>
                          </View>
                          <TouchableOpacity
                            style={[s.sheetBtn, {paddingVertical: 10}]}
                            activeOpacity={0.85}
                            onPress={() => { if (manage.lastLocation) {openInMaps(manage.lastLocation, manage.name);} }}
                            accessibilityRole="button"
                            accessibilityLabel={`Open ${manage.name}'s location in maps`}>
                            <Text style={s.sheetBtnText}>Open in Maps</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <View style={s.locEmpty}>
                        <Icon name="map-marker-off-outline" size={16} color={D.textMute} importantForAccessibility="no" />
                        <Text style={s.locEmptyText}>
                          No location yet — it appears after they open the app with location on.
                        </Text>
                      </View>
                    )}
                  </>
                )}

                {manage.status !== 'pending' && (
                  <>
                    <Text style={s.sectionLabel}>SPENDING · FROM YOUR CREDITS</Text>
                    {spendLoading ? (
                      <View style={{paddingVertical: 14, alignItems: 'center'}}>
                        <ActivityIndicator color={D.accent} />
                      </View>
                    ) : spendError ? (
                      <TouchableOpacity
                        style={s.locEmpty}
                        activeOpacity={0.8}
                        onPress={() => setSpendNonce(n => n + 1)}
                        accessibilityRole="button"
                        accessibilityLabel="Retry loading spending">
                        <Icon name="refresh" size={16} color={D.textMute} importantForAccessibility="no" />
                        <Text style={s.locEmptyText}>Couldn't load spending — tap to retry.</Text>
                      </TouchableOpacity>
                    ) : !spend || spend.transactions.length === 0 ? (
                      <Text style={s.spendEmpty}>Nothing spent from your credits yet.</Text>
                    ) : (
                      <>
                        {spend.byFeature.map(f => (
                          <View key={f.feature} style={s.spendFeatureRow}>
                            <Text style={s.spendFeatureName} numberOfLines={1}>{featureLabel(f.feature)}</Text>
                            <Text style={s.spendFeatureAmt}>
                              {f.spent.toLocaleString()} BC
                              {f.refunded > 0 ? ` · ${f.refunded.toLocaleString()} back` : ''}
                            </Text>
                          </View>
                        ))}
                        <View style={s.spendDivider} />
                        {spend.transactions.slice(0, 6).map(t => (
                          <View key={t.id} style={s.spendTxRow}>
                            <View style={{flex: 1, minWidth: 0}}>
                              <Text style={s.spendTxLabel} numberOfLines={1}>{featureLabel(t.feature)}</Text>
                              <Text style={s.spendTxDate}>{fmtDate(t.at)}</Text>
                            </View>
                            <Text style={[s.spendTxAmt, t.amount > 0 && {color: D.signal}]}>
                              {t.amount > 0
                                ? `+${t.amount.toLocaleString()}`
                                : `−${Math.abs(t.amount).toLocaleString()}`} BC
                            </Text>
                          </View>
                        ))}
                        {spend.transactions.length > 6 ? (
                          <Text style={s.spendMore}>
                            {spend.transactions.length - 6} more in your wallet history
                          </Text>
                        ) : null}
                      </>
                    )}
                  </>
                )}

                {manage.status === 'active' && (
                  <>
                    <Text style={s.sectionLabel}>SPEND LIMIT (BC)</Text>
                    <View style={{flexDirection: 'row', gap: 10}}>
                      <TextInput
                        style={[s.input, {flex: 1, marginTop: 0}]}
                        value={manageLimit}
                        onChangeText={t => setManageLimit(t.replace(/[^\d]/g, ''))}
                        placeholder="No limit"
                        placeholderTextColor={D.textMute}
                        selectionColor={D.accent}
                        keyboardType="number-pad"
                        maxLength={7}
                      />
                      <TouchableOpacity
                        style={s.sheetBtn}
                        activeOpacity={0.85}
                        disabled={busy}
                        onPress={() => { void saveLimit(manage); }}
                        accessibilityRole="button"
                        accessibilityLabel="Save limit">
                        <Text style={s.sheetBtnText}>Save</Text>
                      </TouchableOpacity>
                    </View>

                    <Text style={s.sectionLabel}>{isHeld(manage) ? 'ON HOLD' : 'PUT ON HOLD'}</Text>
                    {isHeld(manage) ? (
                      <TouchableOpacity
                        style={[s.sheetRow]}
                        activeOpacity={0.8}
                        disabled={busy}
                        onPress={() => { void applyHold(manage, null); }}
                        accessibilityRole="button"
                        accessibilityLabel="Lift hold">
                        <Icon name="play-circle-outline" size={18} color={D.signal} />
                        <Text style={[s.sheetRowText, {color: D.signal}]}>
                          Lift hold (held until {fmtDate(manage.heldUntil!)})
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <View style={{flexDirection: 'row', gap: 9}}>
                        {[7, 14, 30].map(d => (
                          <TouchableOpacity
                            key={d}
                            style={[s.chip, {flex: 1, alignItems: 'center'}]}
                            activeOpacity={0.8}
                            disabled={busy}
                            onPress={() => { void applyHold(manage, d); }}
                            accessibilityRole="button"
                            accessibilityLabel={`Hold ${d} days`}>
                            <Text style={s.chipText}>{d} days</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </>
                )}

                <TouchableOpacity
                  style={[s.sheetRow, {marginTop: 18, borderColor: 'rgba(255,93,93,0.3)', backgroundColor: 'rgba(255,93,93,0.06)'}]}
                  activeOpacity={0.8}
                  disabled={busy}
                  onPress={() => removeMember(manage)}
                  accessibilityRole="button"
                  accessibilityLabel="Remove member">
                  <Icon name="account-remove-outline" size={18} color={D.alert} />
                  <Text style={[s.sheetRowText, {color: D.alert}]}>
                    {manage.status === 'pending' ? 'Cancel invite' : 'Remove from family'}
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
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
  headerTitle: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  headerSub: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  centerFill: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40},
  emptyCard: {
    alignItems: 'center', gap: 9, borderRadius: 18, padding: 26,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  emptyTitle: {color: D.textDim, fontFamily: D.fBold, fontSize: 14.5},
  emptySub: {color: D.textMute, fontFamily: D.fSans, fontSize: 12, lineHeight: 17, textAlign: 'center'},

  memberCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 13, borderRadius: 16,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  // §43 — the pending-request card. An amber edge, not the member card's neutral
  // hairline: this row is the only thing on the screen waiting on the holder,
  // and it reads as a task rather than a roster entry.
  requestCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 13, borderRadius: 16,
    backgroundColor: 'rgba(245,199,107,0.06)',
    borderWidth: 1, borderColor: 'rgba(245,199,107,0.28)',
  },
  requestName:   {color: D.text, fontSize: 14, fontFamily: D.fSemi},
  requestAmount: {color: D.amber, fontSize: 12.5, fontFamily: D.fSemi},
  requestReason: {color: D.textDim, fontSize: 11.5, fontFamily: D.fSans, fontStyle: 'italic'},
  requestBtn: {
    minHeight: 36, paddingHorizontal: 14, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  requestBtnGhost:      {backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2},
  requestBtnGhostText:  {color: D.textDim, fontSize: 12.5, fontFamily: D.fSemi},
  requestBtnPrimary:    {backgroundColor: D.accentDeep},
  requestBtnPrimaryText:{color: '#FFFFFF', fontSize: 12.5, fontFamily: D.fSemi},
  avatar: {
    width: 44, height: 44, borderRadius: 22, flexShrink: 0, overflow: 'hidden',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarImg: {width: 44, height: 44, borderRadius: 22},
  avatarText: {color: D.accentSoft, fontFamily: D.fBold, fontSize: 13},
  memberName: {color: D.text, fontFamily: D.fBold, fontSize: 14},
  memberSub: {color: D.textMute, fontFamily: D.fSans, fontSize: 11, marginTop: 3},
  memberLocRow: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, minWidth: 0},
  memberLoc: {flex: 1, minWidth: 0, color: D.accentSoft, fontFamily: D.fSans, fontSize: 10.5},

  relBadge: {
    flexShrink: 0, maxWidth: '40%', paddingVertical: 4, paddingHorizontal: 9, borderRadius: 7,
    backgroundColor: 'rgba(91,141,239,0.13)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
  },
  relBadgeText: {color: D.accentSoft, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1},
  statePill: {flexShrink: 0, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 7, borderWidth: 1},
  statePillText: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1},

  noteCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    marginTop: 18, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
  },
  noteText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 17, color: D.textDim},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 56, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  ctaSent: {borderColor: 'rgba(74,222,128,0.4)'},
  ctaText: {fontFamily: D.fBold, fontSize: 15.5, letterSpacing: 0.3, color: '#fff'},
  gateHint: {color: D.textMute, fontFamily: D.fSans, fontSize: 11.5, textAlign: 'center', marginTop: 10},

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    marginHorizontal: 20, marginBottom: 12, paddingHorizontal: 13,
    borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: D.hair2,
  },
  searchInput: {flex: 1, minWidth: 0, paddingVertical: 11, color: D.text, fontFamily: D.fSans, fontSize: 13.5},

  contactRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: D.hair,
  },

  pickedCard: {
    flexDirection: 'row', alignItems: 'center', gap: 13,
    padding: 15, borderRadius: 16, marginBottom: 6,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },

  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 20, marginBottom: 10,
  },
  chipWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 9},
  chip: {
    paddingVertical: 9, paddingHorizontal: 14, borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  chipOn: {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.5)'},
  chipText: {fontFamily: D.fSemi, fontSize: 12.5, color: D.textDim},

  input: {
    marginTop: 0, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    color: D.text, fontFamily: D.fSans, fontSize: 13.5,
  },

  sheetBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)'},
  sheetCard: {
    backgroundColor: '#10151F', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 20, maxHeight: '86%',
  },

  locCard: {
    borderRadius: 14, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  locMap: {width: '100%', height: 140, backgroundColor: 'rgba(91,141,239,0.08)'},
  locMetaRow: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12},
  locPlace: {color: D.text, fontFamily: D.fSemi, fontSize: 13},
  locTime: {color: D.textMute, fontFamily: D.fSans, fontSize: 10.5, marginTop: 2},
  locEmpty: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  locEmptyText: {flex: 1, minWidth: 0, color: D.textMute, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 16},

  spendEmpty: {color: D.textMute, fontFamily: D.fSans, fontSize: 11.5},
  spendFeatureRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5},
  spendFeatureName: {flex: 1, minWidth: 0, color: D.textDim, fontFamily: D.fSemi, fontSize: 12.5},
  spendFeatureAmt: {flexShrink: 0, color: D.text, fontFamily: D.fBold, fontSize: 12.5},
  spendDivider: {height: 1, backgroundColor: D.hair, marginVertical: 8},
  spendTxRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5},
  spendTxLabel: {color: D.textDim, fontFamily: D.fSans, fontSize: 12},
  spendTxDate: {color: D.textMute, fontFamily: D.fSans, fontSize: 10, marginTop: 1},
  spendTxAmt: {flexShrink: 0, color: D.text, fontFamily: D.fSemi, fontSize: 12.5},
  spendMore: {color: D.textMute, fontFamily: D.fSans, fontSize: 10.5, marginTop: 6, textAlign: 'center'},
  sheetTitle: {color: D.text, fontFamily: D.fBold, fontSize: 17},
  sheetBtn: {
    paddingHorizontal: 18, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.45)',
  },
  sheetBtnText: {color: D.accentSoft, fontFamily: D.fBold, fontSize: 13},
  sheetRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  sheetRowText: {fontFamily: D.fSemi, fontSize: 13.5},
}));
