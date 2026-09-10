/**
 * The workspace → channel half of the news share sheet, as a CONTROLLED,
 * presentational component.
 *
 * Split out of `ShareNewsSheet` for one reason: the sheet imports `ChatScreen`,
 * the messenger runtime and the API layer, so it cannot be rendered by any test
 * in this repo — and a source scan can prove the drill-in handler EXISTS but not
 * that it does anything. Reviewed 2026-08-22: `onPress={() => setOpenGroup(g)}`
 * mutated to `setOpenGroup(null)` left the whole feature dead with every
 * assertion green. This file imports nothing but React Native, so the behaviour
 * is pinned by rendering it (`shareChannelPicker.test.tsx`).
 *
 * Controlled on purpose — the sheet owns `openGroupId` because it must also
 * clear it when the sheet closes. `openGroup` is RESOLVED from the live groups
 * rather than held as an object, so an id left over from a previous share can
 * never render a workspace that is no longer in the list: it falls back to the
 * root view instead of showing stale channels with stale roles.
 */
import React from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {treeGuides, type ShareWorkspaceGroup, type ShareChannelTarget, type ShareBlockedReason, type GuideCell} from './shareChannelTargets';

/** Gutter geometry — the same 12dp base / 18dp step ChannelTree indents by, so
 *  a channel sits where the member directory would put it. */
const INDENT_BASE = 12;
const INDENT_STEP = 18;
const RAIL = 'rgba(255,255,255,0.16)';

/** One row's branch gutter: a rail slice per ancestor column, plus the elbow
 *  into this row on the last one. Mirrors ChannelTree's Gutter visually. */
function Guides({cells}: {cells: readonly GuideCell[]}) {
  if (cells.length === 0) {return <View style={{width: INDENT_BASE}} />;}
  return (
    <View pointerEvents="none" style={[gut.wrap, {width: cells.length * INDENT_STEP, marginLeft: INDENT_BASE}]}>
      {cells.map((c, i) => (
        <View key={i} style={gut.cell}>
          {c.elbow ? (
            <>
              <View style={gut.railTop} />
              <View style={gut.railArm} />
              {c.cont && <View style={gut.railBottom} />}
            </>
          ) : c.cont ? <View style={gut.railFull} /> : null}
        </View>
      ))}
    </View>
  );
}

const gut = StyleSheet.create({
  wrap: {flexDirection: 'row'},
  cell: {flex: 1},
  railTop:    {position: 'absolute', top: 0, height: '50%', left: '50%', width: 1.5, marginLeft: -0.75, backgroundColor: RAIL},
  railBottom: {position: 'absolute', top: '50%', bottom: 0, left: '50%', width: 1.5, marginLeft: -0.75, backgroundColor: RAIL},
  railFull:   {position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1.5, marginLeft: -0.75, backgroundColor: RAIL},
  railArm:    {position: 'absolute', top: '50%', left: '50%', right: 2, height: 1.5, marginTop: -0.75, backgroundColor: RAIL},
});

/** Copy for a row that cannot receive a share, so the user is never left
 *  wondering why their channel is greyed out. */
export const BLOCKED_LABEL: Record<ShareBlockedReason, string> = {
  read_only: 'Read-only',
  not_active: 'Not set up yet',
};

export interface ShareChannelPickerProps {
  groups: ShareWorkspaceGroup[];
  /** True while the channel list is still being fetched. */
  loading: boolean;
  /** The drilled-into workspace, or null for the workspace list. */
  openGroupId: string | null;
  onOpenGroup: (groupId: string) => void;
  onPickChannel: (target: ShareChannelTarget) => void;
}

/** The workspace LIST (level 1). Renders nothing when there is nothing to show,
 *  so a member with no workspace never sees an empty section header. */
export function ShareWorkspaceList({
  groups, loading, onOpenGroup,
}: Pick<ShareChannelPickerProps, 'groups' | 'loading' | 'onOpenGroup'>) {
  if (groups.length === 0 && !loading) {return null;}
  return (
    <View>
      <Text style={s.section}>WORKSPACES</Text>
      {groups.map(g => (
        <TouchableOpacity
          key={g.id}
          style={[s.row, s.rowPad]}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`${g.name}, ${g.channels.length} channels`}
          onPress={() => onOpenGroup(g.id)}>
          <Icon name="domain" size={18} color="#5B8DEF" />
          <Text style={s.rowName} numberOfLines={1}>{g.name}</Text>
          <Text style={s.rowCount}>{g.channels.length}</Text>
          <Icon name="chevron-right" size={18} color="rgba(180,188,204,0.45)" />
        </TouchableOpacity>
      ))}
      {loading && (
        <View style={s.loadingRow}>
          <ActivityIndicator color="#5B8DEF" size="small" />
          <Text style={s.loadingText}>Loading workspaces…</Text>
        </View>
      )}
    </View>
  );
}

/** The CHANNEL list (level 2) for one workspace. */
export function ShareChannelList({
  group, onPickChannel,
}: {group: ShareWorkspaceGroup; onPickChannel: (t: ShareChannelTarget) => void}) {
  // The branch lines the member directory draws, echoed here (client 2026-08-22).
  const guides = treeGuides(group.channels.map(c => c.depth));
  return (
    <ScrollView style={s.scroll} nestedScrollEnabled>
      {group.channels.map((c, i) => (
        <TouchableOpacity
          key={c.channelId}
          style={[s.row, !c.postable && s.rowOff]}
          activeOpacity={c.postable ? 0.7 : 1}
          disabled={!c.postable}
          accessibilityRole="button"
          accessibilityState={{disabled: !c.postable}}
          accessibilityLabel={
            c.postable
              ? `Share to ${c.name}`
              : `${c.name}, ${BLOCKED_LABEL[c.blockedReason ?? 'read_only']}`
          }
          onPress={() => onPickChannel(c)}>
          <Guides cells={guides[i] ?? []} />
          <Icon name="pound-box-outline" size={18} color={c.postable ? '#5B8DEF' : 'rgba(180,188,204,0.35)'} />
          <Text style={[s.rowName, !c.postable && s.rowNameOff]} numberOfLines={1}>{c.name}</Text>
          {!c.postable && <Text style={s.rowTag}>{BLOCKED_LABEL[c.blockedReason ?? 'read_only']}</Text>}
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

/**
 * Resolve the drilled-into group from the LIVE list.
 *
 * Exported so the sheet can render its own header (the back chevron needs the
 * name) from the same resolution, and so the "stale id falls back to root" rule
 * is one expression rather than two.
 */
export function resolveOpenGroup(
  groups: readonly ShareWorkspaceGroup[], openGroupId: string | null,
): ShareWorkspaceGroup | null {
  if (!openGroupId) {return null;}
  return groups.find(g => g.id === openGroupId) ?? null;
}

export const s = StyleSheet.create({
  scroll: {maxHeight: 400},
  section: {color: 'rgba(180,188,204,0.45)', fontSize: 10, fontWeight: '800', letterSpacing: 1.4, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 6},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingRight: 16, paddingVertical: 11},
  rowOff: {opacity: 0.45},
  // Channel rows get their left inset from the branch gutter; every other row
  // still needs one of its own.
  rowPad: {paddingLeft: 16},
  rowName: {color: '#FFFFFF', fontSize: 13, fontWeight: '700', flex: 1},
  rowNameOff: {color: 'rgba(229,233,242,0.62)'},
  rowCount: {color: 'rgba(180,188,204,0.45)', fontSize: 11, fontWeight: '700'},
  rowTag: {color: 'rgba(180,188,204,0.45)', fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6},
  loadingRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 10},
  loadingText: {color: 'rgba(180,188,204,0.45)', fontSize: 12},
});
