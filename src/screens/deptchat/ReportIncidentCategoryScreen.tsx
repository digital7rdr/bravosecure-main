import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, TouchableOpacity} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {DeptIncidentStackParamList} from '@navigation/types';
import type {IncidentCategoryDto, IncidentSeverityDto} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {useActiveWorkspace, contextManagerRole} from '@store/activeWorkspace';
import {activeWorkspaceOrgParam} from '@store/activeWorkspace';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, useInDepartmentalShell} from './_obsidian';
import {INCIDENT_CATEGORIES, INCIDENT_CATEGORY_META, INCIDENT_SEVERITIES} from './incidentMeta';
import {loadIncidentDraft, clearIncidentDraft, consumeIncidentSubmitted, type IncidentDraft} from './incidentDraft';

// Registered ONLY in the Departmental Incident stack (DepartmentalNavigator).
// `AgentStackParamList` merely DECLARES these routes; it does not mount them.
// Typing against the stack that actually hosts this screen is what makes the
// MyIncidents navigate below provably reachable rather than a silent dead tap.
type Nav = NativeStackNavigationProp<DeptIncidentStackParamList>;

export default function ReportIncidentCategoryScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();
  const userId = useAuthStore(st => st.user?.id);
  /**
   * UI corrections 2026-08-15 item 09 — the manager's door to the QUEUE.
   *
   * Item 09 makes this screen the Incident tab's root for BOTH roles, so the
   * queue stopped being the thing a manager lands on. It must not stop being
   * REACHABLE — a manager who can no longer review submitted incidents has lost
   * the module, not been unblocked from it.
   *
   * Resolved with the ONE shared predicate the rest of the workspace uses
   * (contextManagerRole first, then the server-resolved is_org_manager flag), so
   * a workspace owner browsing a workspace they merely joined does not get
   * manager chrome pointed at their OWN org's queue. The server still guards the
   * queue itself; this only decides whether to show the row.
   */
  const meUser = useAuthStore(st => st.user);
  const activeCtx = useActiveWorkspace(st => st.workspace);
  const ctxManager = contextManagerRole(activeCtx, meUser?.owns_workspace === true);
  const isManager = ctxManager !== null
    ? ctxManager
    : !!meUser && (meUser.is_org_manager ?? (meUser.role === 'service_provider' || meUser.account_kind === 'agency'));
  // vs2 item 4 — drafts are per (user, ORG). Read at use time, not at
  // mount: the user can switch workspaces without this screen unmounting.
  const activeOrgId = activeWorkspaceOrgParam()?.orgId ?? null;
  const [category, setCategory] = useState<IncidentCategoryDto | null>(null);
  const [severity, setSeverity] = useState<IncidentSeverityDto | null>(null);
  const [draft, setDraft] = useState<IncidentDraft | null>(null);

  // Item H — surface a saved draft. Focus-refetched so returning from a
  // submitted (draft-cleared) report drops the card.
  useFocusEffect(useCallback(() => {
    // Client review vs2 item 15 made this screen the member's Incident ROOT, so
    // it is never unmounted — it only blurs. The picked category/severity used
    // to be discarded by the pop that unmounted a pushed copy; now they would
    // survive a COMPLETED report and silently pre-categorise the next one.
    // Scoped to that case only: backing out of STEP 2 to change the category is
    // a normal move and keeps the selection.
    if (consumeIncidentSubmitted()) {
      setCategory(null);
      setSeverity(null);
    }
    void loadIncidentDraft(userId, activeOrgId).then(d => {
      // Only offer drafts whose category/severity still parse — a stale draft
      // from a removed category must not navigate into an invalid state.
      if (d && INCIDENT_CATEGORY_META[d.category as IncidentCategoryDto]
          && INCIDENT_SEVERITIES.some(sv => sv.key === d.severity)) {
        setDraft(d);
      } else {
        setDraft(null);
      }
    });
  }, [userId]));

  const resumeDraft = () => {
    if (!draft) {return;}
    navigation.navigate('ReportIncidentDetails', {
      category: draft.category as IncidentCategoryDto,
      severity: draft.severity as IncidentSeverityDto,
      draft: {description: draft.description, media: draft.media, manualLabel: draft.manualLabel},
    });
  };

  const discardDraft = () => {
    void clearIncidentDraft(userId, activeOrgId);
    setDraft(null);
  };

  const ready = category !== null && severity !== null;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Report Incident" onBack={() => navigation.goBack()} pill="STEP 1" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}>

        {draft && (
          <Card style={s.draftCard} onPress={resumeDraft}>
            <Icon name="file-restore-outline" size={20} color={OB.accentSoft} />
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.draftTitle}>Resume draft?</Text>
              <Text style={s.draftSub} numberOfLines={1}>
                {INCIDENT_CATEGORY_META[draft.category as IncidentCategoryDto]?.label ?? draft.category}
                {draft.media.length > 0 ? ` · ${draft.media.length} attachment${draft.media.length === 1 ? '' : 's'}` : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={discardDraft} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
              accessibilityRole="button" accessibilityLabel="Discard draft">
              <Icon name="close-circle" size={18} color={OB.textMute} />
            </TouchableOpacity>
          </Card>
        )}

        {/* Client review vs2 item 15 made this screen the member's Incident
            root, so My Reports lost its old position as the landing screen.
            It stays one tap away from here — without it the member has no
            route to their own submitted reports at all. */}
        <Card style={s.myReportsRow} onPress={() => navigation.navigate('MyIncidents')}>
          <Icon name="clipboard-text-clock-outline" size={20} color={OB.accentSoft} />
          <Text style={s.myReportsText}>My reports</Text>
          <Icon name="chevron-right" size={18} color={OB.textMute} />
        </Card>

        {/* item 09 — the queue, now reached deliberately instead of being the
            screen in the way. Manager-only; the server guards it regardless. */}
        {isManager && (
          <Card style={s.myReportsRow} onPress={() => navigation.navigate('IncidentQueue')}
            accessibilityLabel="Review submitted incidents">
            <Icon name="clipboard-check-outline" size={20} color={OB.accentSoft} />
            <Text style={s.myReportsText}>Review incidents</Text>
            <Icon name="chevron-right" size={18} color={OB.textMute} />
          </Card>
        )}

        <View style={{marginTop: 6}}>
          <SectionLabel>CATEGORY</SectionLabel>
          <View style={s.grid}>
            {INCIDENT_CATEGORIES.map(key => {
              const m = INCIDENT_CATEGORY_META[key];
              const on = category === key;
              return (
                <TouchableOpacity
                  key={key}
                  style={[s.cat, on && s.catOn]}
                  activeOpacity={0.8}
                  onPress={() => setCategory(key)}>
                  <Icon name={m.icon} size={22} color={on ? OB.glow : OB.textDim} />
                  <Text style={[s.catLabel, on && {color: OB.text}]} numberOfLines={2}>{m.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={{marginTop: 22}}>
          <SectionLabel>SEVERITY</SectionLabel>
          <View style={s.sevRow}>
            {INCIDENT_SEVERITIES.map(sv => {
              const on = severity === sv.key;
              return (
                <TouchableOpacity
                  key={sv.key}
                  style={[s.sev, on && {backgroundColor: sv.color + '1F', borderColor: sv.color}]}
                  activeOpacity={0.8}
                  onPress={() => setSeverity(sv.key)}>
                  <View style={[s.sevDot, {backgroundColor: sv.color}]} />
                  <Text style={[s.sevText, on && {color: sv.color}]}>{sv.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </ScrollView>

      <View style={[s.footer, {paddingBottom: inDepartmentalShell ? 12 : insets.bottom + 12}]}>
        <PrimaryButton
          label="Continue"
          icon="arrow-right"
          disabled={!ready}
          onPress={() => {
            if (category && severity) {
              navigation.navigate('ReportIncidentDetails', {category, severity});
            }
          }}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  myReportsRow: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6},
  myReportsText: {flex: 1, minWidth: 0, color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 14},
  draftCard: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6, marginBottom: 12, borderColor: OB.accent + '4D', backgroundColor: OB.accent + '12'},
  draftTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13.5},
  draftSub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 11.5, marginTop: 2},
  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
  cat: {
    width: '47.8%', minHeight: 84, borderRadius: 15, padding: 13, gap: 9,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: OB.hair,
  },
  catOn: {backgroundColor: 'rgba(91,141,239,0.12)', borderColor: 'rgba(91,141,239,0.45)'},
  catLabel: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 12.5, lineHeight: 16},
  sevRow: {flexDirection: 'row', gap: 9},
  sev: {
    flex: 1, alignItems: 'center', gap: 7, paddingVertical: 13, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: OB.hair,
  },
  sevDot: {width: 9, height: 9, borderRadius: 5},
  sevText: {color: OB.textDim, fontFamily: BravoFont.bold, fontSize: 11.5},
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
}));
