/**
 * B-636 (client, 2026-08-23) — the message half of the Channels search.
 *
 * "This search option should allow you to also search for conversations or
 * words in conversations that's inside the chats."
 *
 * Renders under the channel tree while a search is running: one row per matching
 * message, newest-first, with the matched term highlighted in its own line of
 * context. Tapping a row opens the channel the message is in.
 *
 * ── SECTIONED BY ORGANISATION, LIKE THE TREE ABOVE IT ─────────────────────
 *
 * B-624 was "different organization channels must never mix… It must ALWAYS be
 * separate here", and the tree obeys it by rendering one tree per organisation.
 * A flat hit list underneath would put the same pile back on the screen under a
 * different name, so the sections are the caller's own organisation sections and
 * the headings are the caller's own labels.
 *
 * ── WHY THIS IS ITS OWN COMPONENT ─────────────────────────────────────────
 *
 * B-623's lesson: a screen too big to mount in a test is a screen whose
 * behaviour is pinned by source scans, and a scan cannot see whether a value is
 * USED. This mounts on its own in the app Jest project, so the tests press the
 * real rows.
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {formatListTimestamp} from '@utils/helpers';
import {OB, Card, SectionLabel} from '@screens/deptchat/_obsidian';
import type {ChannelMessageHit} from '@screens/deptchat/channelMessageSearch';

export interface ChannelMessageHitsProps {
  sections: ReadonlyArray<{orgId: string | null; hits: ChannelMessageHit[]}>;
  /** The organisation heading, from the SAME resolver the channel tree uses so
   *  one organisation cannot read as two different names on one screen. */
  labelFor: (orgId: string | null) => string;
  /** Whether organisation headings are shown at all — false on the ordinary
   *  single-organisation screen, where a heading would be noise. */
  showOrgLabels: boolean;
  onOpen: (hit: ChannelMessageHit) => void;
}

export function ChannelMessageHits({
  sections, labelFor, showOrgLabels, onOpen,
}: ChannelMessageHitsProps): React.ReactElement | null {
  if (sections.length === 0) {return null;}
  return (
    <View testID="channel-message-hits">
      {sections.map(section => (
        <View key={`msgs-${section.orgId ?? 'none'}`} style={s.block}>
          <SectionLabel numberOfLines={2}>
            {showOrgLabels
              ? `${labelFor(section.orgId)} · Messages`
              : 'Messages'}
          </SectionLabel>
          <Card style={s.card}>
            {section.hits.map((hit, i) => (
              <HitRow
                key={`${hit.conversationId}:${hit.messageId}`}
                hit={hit}
                last={i === section.hits.length - 1}
                onPress={() => onOpen(hit)}
              />
            ))}
          </Card>
        </View>
      ))}
    </View>
  );
}

function HitRow({hit, last, onPress}: {
  hit: ChannelMessageHit;
  last: boolean;
  onPress: () => void;
}): React.ReactElement {
  const {before, match, after} = hit.snippet;
  return (
    <TouchableOpacity
      testID={`channel-msg-hit-${hit.messageId}`}
      style={[s.row, !last && s.rowDivider]}
      activeOpacity={0.75}
      onPress={onPress}
      accessibilityRole="button"
      // The channel is named first because it is what the tap DOES; the body
      // follows as the reason this row is here.
      accessibilityLabel={`Open ${hit.channelName}. Message: ${before}${match}${after}`}>
      <View style={s.rowHead}>
        <Icon name="pound" size={13} color={OB.textMute} />
        <Text style={s.channel} numberOfLines={1}>{hit.channelName}</Text>
        <Text style={s.when}>{formatListTimestamp(hit.createdAt)}</Text>
      </View>
      {/* One line, ellipsised: the snippet is already centred on the match, so
          a second line would push the highlight off the row it belongs to. */}
      <Text style={s.body} numberOfLines={1}>
        <Text style={s.bodyDim}>{before}</Text>
        <Text style={s.bodyHit}>{match}</Text>
        <Text style={s.bodyDim}>{after}</Text>
      </Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  block: {marginBottom: 18},
  card: {paddingHorizontal: 0, paddingVertical: 0, overflow: 'hidden'},
  // 56dp of vertical room across two lines — comfortably over the 44dp target.
  row: {paddingHorizontal: 14, paddingVertical: 11, gap: 4},
  rowDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: OB.hair},
  rowHead: {flexDirection: 'row', alignItems: 'center', gap: 6},
  channel: {
    flex: 1, minWidth: 0,
    color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13, letterSpacing: 0.1,
  },
  when: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10},
  body: {fontFamily: BravoFont.sans, fontSize: 12.5, lineHeight: 17},
  bodyDim: {color: OB.textDim},
  // The one accent on the row — it is the answer to what was typed.
  bodyHit: {color: OB.accentSoft, fontFamily: BravoFont.semiBold},
});
