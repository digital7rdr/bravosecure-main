/**
 * Provider · Org Chart — who reports to whom, as a tiered graph.
 *
 * org_members has no reports_to column, so this is a ROLE tier (owner →
 * managers → cpos/employees), not a reporting chain. Rendering that honestly
 * matters: inventing a per-manager CPO assignment the data cannot back would be
 * a lie the UI tells.
 *
 * Connectors are plain Views (1px hairlines) — no charting dependency for what
 * is at most a 10-member roster.
 */
import React, {useCallback, useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image,
  StatusBar, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {orgApi, type OrgHierarchy, type OrgHierarchyNode} from '@services/api';
import {ZoomableView} from '@components/ZoomableView';
import LoadingView from '@components/LoadingView';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

const D = {
  bg: '#07090D', card: '#11151D', text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)', hair: 'rgba(255,255,255,0.07)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', amber: '#F5C76B', signal: '#4ADE80',
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

// Ring colour encodes position; suspended members dim + go amber.
function ring(n: OrgHierarchyNode): string {
  if (n.status === 'suspended') {return 'rgba(245,199,107,0.55)';}
  if (n.position === 'Owner') {return 'rgba(91,141,239,0.75)';}
  if (n.position === 'Manager') {return 'rgba(169,197,255,0.55)';}
  return 'rgba(255,255,255,0.18)';
}

// Always-visible DUTY dot — green when the member has toggled ON DUTY, gray
// otherwise. B-203: this reflects the on-duty toggle (availability to work),
// NOT socket connectivity. An off-duty guard with the app merely open was
// showing green and misreading as available; the agency needs "who is on duty
// right now" at a glance, which is exactly the assign-crew signal.
function dutyTone(n: OrgHierarchyNode): {color: string; label: string} {
  return n.on_duty ? {color: '#22C55E', label: 'on duty'} : {color: '#4B5563', label: 'off duty'};
}

function PresenceDot({color, size}: {color: string; size: number}) {
  const dotSize = Math.max(10, size * 0.28);
  return (
    <View
      style={[st.presenceDot, {
        width: dotSize, height: dotSize, borderRadius: dotSize / 2, backgroundColor: color,
      }]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}

function Node({n, size, onPress}: {n: OrgHierarchyNode; size: number; onPress: () => void}) {
  const dim = n.status === 'suspended';
  const tone = dutyTone(n);
  return (
    <TouchableOpacity
      style={[st.node, dim && {opacity: 0.55}]}
      activeOpacity={0.75}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${n.display_name ?? 'Member'}, ${n.position}, ${tone.label}`}>
      <View>
        {n.avatar_url ? (
          <Image
            source={{uri: n.avatar_url}}
            style={{width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: ring(n)}}
          />
        ) : (
          <View style={[st.fallback, {
            width: size, height: size, borderRadius: size / 2, borderColor: ring(n),
          }]}>
            <Text style={[st.initials, {fontSize: size * 0.33}]}>{initials(n.display_name)}</Text>
          </View>
        )}
        <PresenceDot color={tone.color} size={size} />
      </View>
      <Text style={st.nodeName} numberOfLines={1}>{n.display_name ?? '—'}</Text>
      <Text style={st.nodePos} numberOfLines={1}>{n.position}</Text>
    </TouchableOpacity>
  );
}

export default function OrgHierarchyScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const {width: screenWidth} = useWindowDimensions();
  const navigation = useNavigation<Nav>();
  const [data, setData] = useState<OrgHierarchy | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // B-203 — the dot is DUTY status from the hierarchy payload now, not socket
  // presence, so re-fetch on focus (a duty toggle elsewhere should reflect when
  // the owner returns to the chart) rather than holding a live WS subscription.
  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await orgApi.getOrgHierarchy();
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the org chart.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // Tapping a node surfaces the details the owner asked for: email + position.
  const openNode = useCallback((n: OrgHierarchyNode) => {
    const lines = [
      n.email ?? 'No email on file',
      `Position · ${n.position}`,
      n.call_sign ? `Call sign · ${n.call_sign}` : null,
      n.status !== 'active' ? `Status · ${n.status.toUpperCase()}` : null,
    ].filter(Boolean).join('\n');

    // The owner now has a real profile too (getMemberProfile serves it from
    // public.users when memberUserId === orgUserId — see org-cpo.service.ts) —
    // this used to be the one node with no way past the popup.
    const buttons: Array<{text: string; style?: 'cancel' | 'destructive'; onPress?: () => void}> = [{
      text: 'View full profile',
      onPress: () => navigation.navigate('OrgCpoProfile', {
        memberUserId: n.user_id, displayName: n.display_name,
      }),
    }];
    buttons.push({text: 'Close', style: 'cancel'});
    Alert.alert(n.display_name ?? 'Member', lines, buttons);
  }, [navigation]);

  const managers = data?.managers ?? [];
  const members = data?.members ?? [];

  return (
    <View style={[st.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={st.header}>
        <TouchableOpacity onPress={() => goBackOnce(navigation)} style={st.backBtn} activeOpacity={0.7}>
          <Icon name="chevron-left" size={26} color={D.text} />
        </TouchableOpacity>
        <View style={st.accentBar} />
        <Text style={st.headerTitle}>ORG CHART</Text>
        <TouchableOpacity
          onPress={() => { setRefreshing(true); void load(); }}
          style={st.refreshBtn}
          activeOpacity={0.7}
          disabled={refreshing}
          accessibilityLabel="Refresh org chart"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          {refreshing
            ? <ActivityIndicator color={D.accentSoft} size="small" />
            : <Icon name="refresh" size={19} color={D.accentSoft} />}
        </TouchableOpacity>
      </View>

      {loading ? (
        <LoadingView compact label="Loading org chart…" />
      ) : error || !data ? (
        <Text style={st.empty}>{error ?? 'Nothing to show.'}</Text>
      ) : (
        <>
          <Text style={st.hint}>
            Tap anyone to see their email and position · pinch to zoom, drag to pan.
          </Text>

          {/* A growing roster needs room to breathe, not a crushed grid — pinch/pan
              instead of forcing everything into one screen. */}
          <ZoomableView style={{flex: 1}}>
            <View style={{width: screenWidth, paddingHorizontal: 20, paddingBottom: bottomPad(28)}}>
              {/* ── Tier 1 · Owner ── */}
              <View style={{alignItems: 'center'}}>
                <Node n={data.owner} size={76} onPress={() => openNode(data.owner)} />
              </View>

              {/* ── Tier 2 · Managers ── */}
              {managers.length > 0 && (
                <>
                  <View style={st.trunk} />
                  <Text style={st.tierLabel}>MANAGERS · {managers.length}</Text>
                  <View style={st.tierRow}>
                    {managers.map(n => (
                      <Node key={n.user_id} n={n} size={62} onPress={() => openNode(n)} />
                    ))}
                  </View>
                </>
              )}

              {/* ── Tier 3 · CPOs / Employees ── */}
              {members.length > 0 && (
                <>
                  <View style={st.trunk} />
                  <Text style={st.tierLabel}>OFFICERS · {members.length}</Text>
                  <View style={st.grid}>
                    {members.map(n => (
                      <Node key={n.user_id} n={n} size={56} onPress={() => openNode(n)} />
                    ))}
                  </View>
                </>
              )}

              {managers.length === 0 && members.length === 0 && (
                <Text style={st.empty}>No one on the roster yet.</Text>
              )}
            </View>
          </ZoomableView>
        </>
      )}
    </View>
  );
}

const st = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: D.hair,
  },
  backBtn: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  accentBar: {width: 3, height: 16, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 15, color: D.text, letterSpacing: 1.4},
  refreshBtn: {width: 30, height: 30, alignItems: 'center', justifyContent: 'center'},
  hint: {
    fontFamily: D.fSans, fontSize: 11.5, color: D.textMute,
    textAlign: 'center', marginBottom: 18,
  },
  empty: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, textAlign: 'center', marginTop: 40},

  // Vertical connector between tiers.
  trunk: {
    width: StyleSheet.hairlineWidth * 2, height: 26, alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)', marginVertical: 4,
  },
  tierLabel: {
    fontFamily: D.fBold, fontSize: 9.5, color: D.textFaint, letterSpacing: 1.4,
    textAlign: 'center', marginBottom: 12,
  },
  // Dynamic: 1 manager centers directly under the owner; multiple wrap and
  // spread evenly (left/middle/right) instead of pinning to the left edge.
  tierRow: {
    flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'center', gap: 18, paddingHorizontal: 4,
  },
  grid: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 18},

  node: {alignItems: 'center', width: 84, gap: 5},
  fallback: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 2,
  },
  initials: {fontFamily: D.fBold, color: D.accentSoft},
  presenceDot: {position: 'absolute', right: -1, bottom: -1, borderWidth: 2, borderColor: D.bg},
  nodeName: {fontFamily: D.fSemi, fontSize: 11.5, color: D.text, textAlign: 'center'},
  nodePos: {fontFamily: D.fMono, fontSize: 9, color: D.textMute, letterSpacing: 0.5},
}));
