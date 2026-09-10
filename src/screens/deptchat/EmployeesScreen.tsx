import React, {useCallback, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl,
  ActivityIndicator, TextInput, TouchableOpacity,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {Alert} from '@utils/alert';
import {useActiveWorkspace} from '@store/activeWorkspace';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import {orgApi, type RosterMember} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {warnStrandedClaims} from '@utils/strandedClaimsAlert';
import {OB, ObHeader, SectionLabel, Card, ErrorState, loadErrorText} from './_obsidian';
import {BravoContactPicker} from './BravoContactPicker';
import {deptEmployeeNoun} from './deptNoun';

/**
 * M1A rule 16 — the Enterprise workspace roster: enroll existing app users
 * as EMPLOYEES (dept channels + attendance + incident reporting; never a
 * deployable CPO, never changes the member's own app). Also usable by a
 * provider org for back-office staff — their CPO roster lives elsewhere
 * and is untouched (rule 7).
 */
type Nav = NativeStackNavigationProp<MessengerStackParamList>;

export default function EmployeesScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const me = useAuthStore(st => st.user);
  // Demoting a MANAGER is owner-only (server rule: a manager who could unmake
  // a peer could then suspend them). "Owner" means owner OF THE ORG THIS
  // ROSTER SHOWS — the org-identity check, not owns_workspace: a workspace
  // owner who also manages an agency would otherwise see a dead demote button
  // on the agency roster (round-2 edge #2). A workspace owner's org IS
  // themselves; the agency company account is its own org with no org row.
  /**
   * vs2 item 4 — "OWNER OF THE ORG THIS ROSTER SHOWS" now has to be asked of
   * the org the user is VIEWING, which the expression below could not see.
   *
   * `me.org` is the discriminator's primary org. Priya owns Acme and manages
   * Borealis; inside Borealis's roster `me.org?.id === me.id` still read true,
   * so she was shown the owner-only DEMOTE control on another company's staff.
   * The server refuses it, so this was a dead button rather than an
   * escalation — but a dead destructive button on someone else's roster is its
   * own bug.
   *
   * With a context, the context decides and nothing else can: owner of THAT
   * workspace, or nobody. Without one, the pre-item-4 expression stands.
   */
  const activeCtx = useActiveWorkspace(st => st.workspace);
  const isOwner = activeCtx
    ? activeCtx.role === 'owner'
    : !!me && (me.org?.id === me.id || (me.account_kind === 'agency' && !me.org));
  // A demote sends 'employee' as the VERB only — the server substitutes the
  // role the member's own evidence dictates (managed-CPO agents row of this
  // org ⇒ 'cpo', else 'employee'). Round 3 proved no client-side
  // discriminator survives every persona: listRoster's agent_status join is
  // unscoped, so an independent CPO invited into a workspace diverged from
  // the server's scoped rule and became undemotable.
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [needle, setNeedle] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // F15 — a failure must not read as an empty roster.
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * UI corrections 2026-08-15 item 10 — "This add member option should allow you
   * to select contacts on the Bravo App, along side email and manual number
   * insert."
   *
   * Methods (2) and (3) — email and manual number — already worked: the field
   * below accepts either. Only the CONTACTS lane was missing, and it is the one
   * the founder circled. The sheet is the SAME component InviteMemberScreen
   * uses, not a second copy.
   */
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const {data} = await orgApi.listCpos();
      setMembers(data);
      setLoadError(null);
    } catch (e) {
      setMembers([]);
      setLoadError(loadErrorText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const add = useCallback(async () => {
    const v = needle.trim();
    if (!v || adding) {return;}
    setAdding(true);
    try {
      await orgApi.addEmployee(v);
      setNeedle('');
      await load();
    } catch (e: unknown) {
      const code = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      const msg = code === 'user_not_found'
        ? 'No Bravo account found with that email or phone. Ask them to sign up first (Lite is free).'
        : code === 'already_a_member'
          ? 'They are already on your team.'
          : code === 'member_exists_use_roster_status'
            ? 'This person is on your roster with another role — manage them from the roster instead.'
            : code === 'provider_account_cannot_be_employee'
              ? `That account is a service provider (agency / CPO), not an individual. Only individual Bravo users can be added as ${deptEmployeeNoun(true)}.`
              : 'Could not add this person. Check the details and try again.';
      Alert.alert('Could not add', msg);
    } finally {
      setAdding(false);
    }
  }, [needle, adding, load]);

  /**
   * A pick FILLS THE FIELD; it does not submit.
   *
   * `addEmployee` resolves its needle as an EXACT match on
   * `LOWER(email) = LOWER($1) OR phone_e164 = $1` and has no user-id lane, so a
   * re-derived number that differs by one character 404s "user_not_found" for a
   * contact the picker just proved is a Bravo user (the B-154 double-prefix
   * class). Showing the resolved value first means the admin sees what will be
   * sent and can correct it, instead of getting a confident wrong error.
   *
   * `phoneE164` comes from the discovery match itself — the same normalised
   * string the directory matched on — so it is the closest thing to the value
   * the server stores.
   */
  const pickContact = useCallback((m: {phoneE164: string}) => {
    setNeedle(m.phoneE164);
    setPickerOpen(false);
  }, []);

  const setStatus = useCallback((m: RosterMember, status: 'active' | 'suspended' | 'removed') => {
    const label = m.display_name ?? m.email ?? 'this member';
    const verb = status === 'removed' ? 'Remove' : status === 'suspended' ? 'Suspend' : 'Reinstate';
    Alert.alert(
      `${verb} ${label}?`,
      status === 'removed'
        ? 'They lose access to your channels, attendance and incident reporting. Their own Bravo account is unaffected.'
        : status === 'suspended'
          ? 'They temporarily lose workspace access until reinstated.'
          : 'They regain access to your workspace.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: verb,
          style: status === 'active' ? 'default' : 'destructive',
          onPress: () => {
            void (async () => {
              setBusyId(m.member_user_id);
              try {
                const {data} = await orgApi.setCpoStatus(m.member_user_id, status);
                warnStrandedClaims(data.stranded_room_claims);
                await load();
              } catch {
                Alert.alert('Update failed', 'Please try again.');
              } finally {
                setBusyId(null);
              }
            })();
          },
        },
      ],
    );
  }, [load]);

  // Q7 — promote/demote on the workspace roster (employee ⇄ manager). The
  // server owns authorization: owner + UNSCOPED managers may change roles,
  // the owner can never be targeted, and cpo ⇄ employee is refused — this
  // screen only offers the manager pivot.
  const setRole = useCallback((m: RosterMember, role: 'employee' | 'manager' | 'cpo') => {
    const label = m.display_name ?? m.email ?? 'this member';
    const promote = role === 'manager';
    Alert.alert(
      promote ? `Make ${label} a manager?` : `Remove ${label}'s manager role?`,
      promote
        ? 'They get the admin dashboard: approvals, attendance, incidents and channel management — everything except removing the workspace owner.'
        // Neutral on purpose: the SERVER decides whether they return to the
        // regular-member or CPO role, from its own evidence.
        : 'They keep their place on the roster; manager-only channels and admin tools are withdrawn.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: promote ? 'Make manager' : 'Demote',
          style: promote ? 'default' : 'destructive',
          onPress: () => {
            void (async () => {
              setBusyId(m.member_user_id);
              try {
                const {data} = await orgApi.setCpoRole(m.member_user_id, role);
                warnStrandedClaims(data.stranded_room_claims);
                await load();
              } catch (e: unknown) {
                const code = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
                const copy: Record<string, string> = {
                  cannot_modify_org_owner: 'The workspace owner cannot be changed by anyone.',
                  scoped_manager_cannot_change_roles: 'Your manager role is scoped to one branch, so you cannot change roles.',
                  only_org_owner_can_demote_managers: 'Only the owner can remove a manager’s role.',
                  member_not_active: 'Reinstate this member before changing their role.',
                  role_change_not_allowed: 'That role does not exist on this kind of organisation.',
                  role_changed_concurrently: 'Another admin changed this member’s role at the same time — refresh and try again.',
                };
                const msg = code ? copy[code] ?? 'Please try again.' : 'Please try again.';
                Alert.alert('Update failed', msg);
              } finally {
                setBusyId(null);
              }
            })();
          },
        },
      ],
    );
  }, [load]);

  const employees = members.filter(m => m.member_role === 'employee' && m.status !== 'removed');
  const managers = members.filter(m => m.member_role === 'manager' && m.status !== 'removed');
  const others = members.filter(m => m.member_role === 'cpo' && m.status !== 'removed');

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      {/* B-371 — pushed from DepartmentChannels with headerShown:false; without
          onBack there is NO visible exit (iOS has no hardware key, only the
          undiscoverable edge swipe). Same header shape as ManageChannels. */}
      {/* A7.3 — the tenant's noun, not a hardcoded "Employees". NOTE: the
          NAVIGATION ROUTE is still named 'Employees' (DepartmentChannelsScreen
          navigates to it) and `member_role === 'employee'` below is a SERVER
          DATA VALUE — neither is a label, neither may be renamed here. */}
      <ObHeader title={deptEmployeeNoun(true)} onBack={() => navigation.goBack()} pill="WORKSPACE" />

      <ScrollView
        contentContainerStyle={{padding: 16, paddingBottom: insets.bottom + 32, gap: 12}}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={OB.accent}
          onRefresh={() => { setRefreshing(true); void load(); }} />}
        showsVerticalScrollIndicator={false}>

        <Card>
          <SectionLabel>ADD BY EMAIL OR PHONE</SectionLabel>
          <View style={s.addRow}>
            <TextInput
              style={s.input}
              value={needle}
              onChangeText={setNeedle}
              placeholder="name@company.com or +9715…"
              placeholderTextColor={OB.textMute}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!adding}
            />
            <TouchableOpacity
              style={[s.addBtn, (!needle.trim() || adding) && {opacity: 0.5}]}
              disabled={!needle.trim() || adding}
              onPress={() => { void add(); }}
              accessibilityRole="button"
              accessibilityLabel={`Add ${deptEmployeeNoun()}`}>
              {adding ? <ActivityIndicator color="#FFF" size="small" /> : <Icon name="account-plus" size={20} color="#FFF" />}
            </TouchableOpacity>
          </View>
          {/* item 10 — the third entry method, beside the two that already
              worked. Deliberately BELOW the field: the manual lane stays the
              default because it is the only one that reaches somebody who is not
              in the admin's address book. */}
          <TouchableOpacity
            style={s.pickRow}
            activeOpacity={0.8}
            onPress={() => setPickerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Choose from Bravo contacts">
            <Icon name="account-search-outline" size={18} color={OB.accentSoft} />
            <Text style={s.pickText}>Choose from Bravo Contacts</Text>
            <Icon name="chevron-right" size={18} color={OB.textMute} />
          </TouchableOpacity>

          <Text style={s.hint}>
            They must already have a Bravo account (Lite is free). Adding them
            unlocks your department channels, attendance and incident reporting
            for them — it never changes their own plan or app.
          </Text>
        </Card>

        <SectionLabel>{`${deptEmployeeNoun(true).toUpperCase()} · ${employees.length}`}</SectionLabel>
        {loading ? (
          <LoadingView compact label={`Loading ${deptEmployeeNoun(true)}…`} />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(); }} />
        ) : employees.length === 0 ? (
          <Card>
            <Text style={s.empty}>No {deptEmployeeNoun(true)} yet. Add your first team member above.</Text>
          </Card>
        ) : employees.map(m => (
          <Card key={m.member_user_id}>
            <View style={s.memberRow}>
              <View style={s.avatar}>
                <Icon name="account" size={20} color={OB.accent} />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.name} numberOfLines={1}>{m.display_name ?? m.email ?? deptEmployeeNoun()}</Text>
                <Text style={s.sub} numberOfLines={1}>
                  {m.email ?? '—'} · {m.status === 'suspended' ? 'Suspended' : 'Active'}
                </Text>
              </View>
              {busyId === m.member_user_id ? (
                <ActivityIndicator color={OB.accent} size="small" />
              ) : (
                <View style={s.actions}>
                  {/* Q7 — promote to manager (active members only). */}
                  {m.status === 'active' && (
                    <TouchableOpacity onPress={() => setRole(m, 'manager')} style={s.actBtn}
                      accessibilityRole="button" accessibilityLabel={`Make ${m.display_name ?? 'member'} a manager`}>
                      <Icon name="shield-account-outline" size={18} color={OB.accentSoft} />
                    </TouchableOpacity>
                  )}
                  {m.status === 'suspended' ? (
                    <TouchableOpacity onPress={() => setStatus(m, 'active')} style={s.actBtn}
                      accessibilityRole="button" accessibilityLabel="Reinstate">
                      <Icon name="account-check" size={18} color="#34d399" />
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity onPress={() => setStatus(m, 'suspended')} style={s.actBtn}
                      accessibilityRole="button" accessibilityLabel="Suspend">
                      <Icon name="pause-circle-outline" size={18} color="#F59E0B" />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity onPress={() => setStatus(m, 'removed')} style={s.actBtn}
                    accessibilityRole="button" accessibilityLabel="Remove">
                    <Icon name="account-remove-outline" size={18} color="#F87171" />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </Card>
        ))}

        {/* Q7/Q10 — managers are visible and demotable here (server-enforced:
            owner + unscoped managers; the OWNER has no roster row, so no row
            here can ever target them). Demote returns them to the regular
            member role. */}
        {managers.length > 0 && (
          <>
            <SectionLabel>{`MANAGERS · ${managers.length}`}</SectionLabel>
            {managers.map(m => (
              <Card key={m.member_user_id}>
                <View style={s.memberRow}>
                  <View style={s.avatar}>
                    <Icon name="shield-account" size={20} color={OB.accent} />
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.name} numberOfLines={1}>{m.display_name ?? m.email ?? 'Manager'}</Text>
                    <Text style={s.sub} numberOfLines={1}>
                      {m.email ?? '—'} · Manager{m.department ? ` · ${m.department}` : ''}
                      {m.status === 'suspended' ? ' · Suspended' : ''}
                    </Text>
                  </View>
                  {busyId === m.member_user_id ? (
                    <ActivityIndicator color={OB.accent} size="small" />
                  ) : isOwner && m.status === 'active' ? (
                    <View style={s.actions}>
                      <TouchableOpacity onPress={() => setRole(m, 'employee')} style={s.actBtn}
                        accessibilityRole="button" accessibilityLabel={`Demote ${m.display_name ?? 'manager'}`}>
                        <Icon name="shield-off-outline" size={18} color="#F59E0B" />
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
              </Card>
            ))}
          </>
        )}

        {others.length > 0 && (
          <>
            <SectionLabel>{`OTHER ROSTER MEMBERS · ${others.length}`}</SectionLabel>
            <Card>
              {/* A7.3 — this bucket is `member_role !== 'employee'` (manager and,
                  on a provider tenant, CPO rows). It used to hardcode
                  "CPO/manager", which is the exact Employee/CPO label A7.3 asks
                  to drop on an Enterprise workspace. It cannot render
                  `deptMemberNoun` either — deptNoun.test.ts bans that helper on
                  this screen, because these rows are NOT the employee roster the
                  screen is named after. So the copy is noun-FREE: the section
                  label above already says what the rows are. */}
              <Text style={s.empty}>
                {others.length} other roster member{others.length === 1 ? '' : 's'} managed
                outside this list — untouched here.
              </Text>
            </Card>
          </>
        )}
      </ScrollView>

      <BravoContactPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={pickContact}
        ownPhoneE164={me?.phone_e164 ?? null}
        title="Add from Bravo Contacts"
        // The advice differs from the invite screen's on purpose: this endpoint
        // can only enrol an EXISTING Bravo account, so "invite them anyway" —
        // which is true on the invite sheet — would be a dead end here.
        emptyHint="None of your contacts use Bravo Secure yet. They need a Bravo account (Lite is free) before they can be added."
      />
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  addRow: {flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 8},
  input: {
    flex: 1, height: 46, borderRadius: 12, borderWidth: 1, borderColor: OB.hair,
    backgroundColor: 'rgba(255,255,255,0.03)', color: OB.text, paddingHorizontal: 14, fontSize: 14,
  },
  addBtn: {
    width: 46, height: 46, borderRadius: 12, backgroundColor: OB.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  hint: {color: OB.textMute, fontSize: 11, lineHeight: 16, marginTop: 10},
  empty: {color: OB.textDim, fontSize: 12.5, lineHeight: 18},
  memberRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  avatar: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
  },
  name: {color: OB.text, fontSize: 14.5, fontWeight: '700'},
  sub: {color: OB.textMute, fontSize: 11.5, marginTop: 2},
  actions: {flexDirection: 'row', gap: 6},
  actBtn: {
    width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair,
  },
  // item 10 — the contacts lane. 44dp minimum target, per the design system.
  pickRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, marginTop: 12,
    paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: OB.hair2,
    backgroundColor: 'rgba(91,141,239,0.06)',
  },
  pickText: {flex: 1, minWidth: 0, color: OB.accentSoft, fontSize: 13, fontWeight: '600'},
}));
