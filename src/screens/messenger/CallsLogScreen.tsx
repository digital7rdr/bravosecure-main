import React, {useCallback, useMemo, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  StatusBar,
  Linking,
  type ListRenderItemInfo,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useMessengerStore, selectCallMessages} from '@/modules/messenger/store';
import {UserAvatar} from '@/modules/messenger/ui/UserAvatar';
import {isDirectPrefixed, peerFromDirectSlot} from '@/modules/messenger/conversationIds';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {avatarColorFor} from './avatarColors';
import {useEmergencyCallLog, recordEmergencyCall} from '@store/emergencyCallLog';
import {Alert} from '@utils/alert';
import {UNIVERSAL_EMERGENCY, type EmergencyEntry} from '@screens/vbg/emergencyNumbers';

type FilterTab = 'all' | 'missed' | 'voice' | 'video';

interface CallLog {
  id: string;
  conversationId: string;
  /** B-254 — peer userId for a 1:1, so the row can show their photo. */
  peerId: string | null;
  name: string;
  initials: string;
  bg: string;
  rounded: boolean;
  type: 'voice' | 'video';
  /** WhatsApp-style direction+outcome combined for the colored arrow. */
  direction: 'in' | 'out' | 'missed';
  /** Outcome from call_meta — drives the red/green tint on the icon. */
  outcome: 'answered' | 'missed' | 'declined' | 'failed' | 'ended-by-host';
  duration?: string;
  time: string;
  timestampMs: number;
  isGroup?: boolean;
}

/**
 * PDF item 08 — "Emergency Calls have not been added to Calls Log."
 *
 * ⚠️ A DISCRIMINATED UNION, NOT AN EXTRA FLAG ON `CallLog`.
 *
 * Every field of `CallLog` is WebRTC-derived — `conversationId`, `peerId`,
 * `outcome`, `duration` — and an emergency call has NONE of them: it is a
 * `tel:` hand-off to the OS, which reports nothing back. Bolting an
 * `isEmergency?: boolean` onto `CallLog` would have left five fields that are
 * structurally meaningless for half the rows, and — the part that actually
 * bites — the row tap calls `launchCall({conversationId})`, which for an
 * emergency row would resolve no peer and silently do nothing.
 *
 * The union makes both problems unrepresentable: an emergency row simply has
 * no `conversationId` to pass, so the tap MUST be written separately, and TS
 * refuses any code that reads a WebRTC field off one.
 *
 * NO OUTCOME IS INVENTED. There is no duration, no answered/missed. The OS
 * never tells us, and a guessed value would look exactly like a measured one
 * in a log people consult after an incident.
 */
interface EmergencyLog {
  id: string;
  /** The label the user tapped ("Police"), or the number when there was none. */
  name: string;
  /** Always shown, because the label alone does not say WHAT was dialled. */
  number: string;
  source: 'directory' | 'next-of-kin' | 'quick-dial';
  time: string;
  timestampMs: number;
}

/** What the list actually renders. `kind` is the only safe way to tell them
 *  apart — see the note on EmergencyLog. */
type Row = ({kind: 'call'} & CallLog) | ({kind: 'emergency'} & EmergencyLog);

const SOURCE_LABEL: Record<EmergencyLog['source'], string> = {
  directory: 'Emergency services',
  'next-of-kin': 'Next of kin',
  'quick-dial': 'Safety hotline',
};

// B-286 — the calls log keyed on the conversation id already, but against its
// own palette, so the same person was one colour here and another in the list.
function avatarBg(seed: string): string {
  return avatarColorFor(seed);
}
function initialsOf(s: string): string {
  return s.split(/\s+/).slice(0, 2).map(p => p[0] ?? '').join('').toUpperCase() || '?';
}
function fmtDuration(sec?: number): string | undefined {
  if (!sec || sec < 1) {return undefined;}
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) {return `${s}s`;}
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000)        {return 'just now';}
  if (diff < 3_600_000)     {return `${Math.floor(diff / 60_000)}m ago`;}
  if (diff < 86_400_000)    {return `${Math.floor(diff / 3_600_000)}h ago`;}
  if (diff < 7 * 86_400_000){return `${Math.floor(diff / 86_400_000)}d ago`;}
  return new Date(ms).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

const FILTERS: {key: FilterTab; label: string}[] = [
  {key: 'all', label: 'All'},
  {key: 'missed', label: 'Missed'},
  {key: 'voice', label: 'Voice'},
  {key: 'video', label: 'Video'},
];

type QuickDialChip = {label: string; number: string; strong?: boolean};

/**
 * B-638 — ONE sanitiser, applied where the chip is BUILT.
 *
 * The first version sanitised only at dial time, so the chip printed
 * `0900-8844` while the dialler and the call log both got `09008844` — three
 * places free to drift. Sanitising once at construction makes the label, the
 * `tel:` intent and the logged row the same string by construction, and it also
 * lets the dedupe compare what is actually dialled rather than what is typed in
 * the directory.
 */
function sanitiseDialNumber(raw: string): string {
  return raw.replace(/[^\d+*#]/g, '');
}

/**
 * B-638 — the one-tap chips for a country. Exported pure so the chip set is
 * testable without a locale.
 *
 * Three rules, each of which got a review round to arrive at:
 *
 * - **Deduped by the number ACTUALLY DIALLED.** Bangladesh is `999` for all
 *   four services and Australia is `000`; the version B-626 deleted rendered
 *   four identical numbers under four labels.
 * - **…but the labels MERGE rather than vanish.** A plain dedupe deleted a
 *   whole service in 47 countries — see the note in `push`.
 * - **112 is always PRESENT; the country's own number is what's EMPHASISED.**
 *   See the note above the return.
 */
export function emergencyQuickDialChips(entry: EmergencyEntry | null): QuickDialChip[] {
  const out: QuickDialChip[] = [];
  const push = (label: string, number?: string): void => {
    if (!number) {return;}
    const sanitised = sanitiseDialNumber(number);
    if (!sanitised) {return;}
    const existing = out.find(c => c.number === sanitised);
    if (existing) {
      // MERGE the label instead of dropping it. Dropping silently deleted a
      // whole service in 47 countries — Ireland is `all:112, police/ambulance/
      // fire:999`, so a plain dedupe showed someone who needs an ambulance a
      // button labelled "Police". Japan lost "Fire" behind "Ambulance".
      if (!existing.label.split(' / ').includes(label)) {
        existing.label = `${existing.label} / ${label}`;
      }
      return;
    }
    out.push({label, number: sanitised});
  };
  push('All services', entry?.all);
  push('Police',       entry?.police);
  push('Ambulance',    entry?.ambulance);
  push('Fire',         entry?.fire);
  // 112 must always be PRESENT — but where a country's own number already IS
  // 112 there is nothing to add, and merging the label would render the noise
  // "All services / Universal".
  if (!out.some(c => c.number === UNIVERSAL_EMERGENCY)) {
    out.push({label: 'Universal', number: UNIVERSAL_EMERGENCY});
  }

  /**
   * ⚠️ WHICH CHIP IS EMPHASISED — this rule was WRONG in the first version and
   * the two reviews disagreed about it, so the reasoning is recorded here.
   *
   * v1 always emphasised 112, on the argument that the country is only a guess
   * so the universally-true number should dominate. **That inverts the moment
   * the guess is RIGHT:** on a correctly-detected US phone it made 112 the big
   * red button and de-emphasised 911 — the number that is official, guaranteed
   * and location-routed there. Same for 000/111/110 countries.
   *
   * The rule that satisfies both: emphasise the country's OWN first-listed
   * number when we have a country, and 112 when we do not. 112 is always
   * PRESENT either way, so a wrong guess still leaves the universal number one
   * tap away — it just is not shouting over the correct local one.
   */
  const emphasis = out[0]?.number;
  return out.map(c => ({...c, strong: c.number === emphasis}));
}

/**
 * B-638 (client, 2026-08-23) — the emergency card is back, pinned above the
 * filter tabs. It replaces the B-626 header word rather than sitting beside it.
 *
 * ── ⚠️ THE COUNTRY IS A GUESS, AND THE CARD SAYS SO ───────────────────────
 *
 * `getDeviceCountryIso()` reads the phone's LOCALE — `I18nManager.localeIdentifier`
 * / `AppleLocale`, falling back to `Intl`. It is offline and has **nothing to do
 * with where the user actually is**. So a person in Bangladesh holding an
 * `en_US` phone would be shown "United States" and offered **911**.
 *
 * The first fix for this was to drop the country name. Review showed that makes
 * it WORSE: strip the label and the same person sees "tap a number to call" over
 * a 911 chip with nothing saying whose 911 it is — the wrong guess is hidden
 * instead of visible and correctable. So the card **names the country, says
 * where that came from, and offers a way out**: the whole header row opens the
 * full searchable directory, which already accepts a country.
 *
 * ── 2026-08-24, founder call: the CHEVRON-ONLY banner after all. ──────────
 * The v1 of this card argued one-tap chips beat a two-tap directory in an
 * emergency and shipped quick-dial chips. The founder, having both designs on
 * a device, chose the banner ("exact like this"): one calm affordance whose
 * single job is opening the full directory — where the location-pinned country
 * card dials in one further tap, with the country VISIBLE at dial time (the
 * chips dialled a locale-guessed country's number with the guess hidden by
 * brevity). `emergencyQuickDialChips` stays exported: the directory's country
 * cards use the same merge/emphasis rules.
 */
function EmergencyQuickDial({onOpenDirectory}: {onOpenDirectory: () => void}) {
  return (
    <TouchableOpacity
      style={styles.emergencyCard}
      activeOpacity={0.85}
      accessibilityRole="button"
      hitSlop={{top: 6, bottom: 6, left: 4, right: 4}}
      accessibilityLabel="Emergency services. Reach emergency services on any network worldwide. Opens the country directory."
      onPress={onOpenDirectory}>
      <View style={styles.emergencyTile}>
        <Icon name="phone" size={22} color="#FFFFFF" />
      </View>
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={styles.emergencyTitle}>EMERGENCY CALLS</Text>
        <Text style={styles.emergencySub} numberOfLines={2}>
          Reach emergency services{'\n'}on any network worldwide.
        </Text>
      </View>
      <Icon name="chevron-right" size={22} color="#FF6B6B" />
    </TouchableOpacity>
  );
}

/**
 * B-655 — the call-log row, MEMOISED and rendered through a FlatList.
 *
 * This markup used to live inline in a `visible.map(...)` inside a plain
 * `ScrollView`, so every row in the whole call history was mounted and every
 * re-render of the body re-created ~15 elements per row. Extracting it lets
 * `React.memo` bail out per row, and virtualising bounds how many exist.
 */
const getDirectionIcon = (c: CallLog): {name: string; color: string} => {
  if (c.direction === 'missed') {return {name: 'phone-missed', color: '#FF3B3B'};}
  if (c.outcome === 'failed')   {return {name: 'phone-alert', color: '#FFC107'};}
  return {
    name:  c.type === 'video' ? 'video-outline' : 'phone-in-talk',
    color: '#00C853',
  };
};

const getDirArrow = (c: CallLog): {name: string; color: string} | null => {
  if (c.direction === 'out')    {return {name: 'arrow-top-right',    color: '#00C853'};}
  if (c.direction === 'in')     {return {name: 'arrow-bottom-left',  color: '#00C853'};}
  if (c.direction === 'missed') {return {name: 'arrow-bottom-left',  color: '#FF3B3B'};}
  return null;
};

const callRowKey = (r: Row): string => r.id;

// The row takes the screen's real navigation object; the loose structural cast
// that `launchCall` needs stays at the call site inside the row, exactly as it
// was when this markup was inline.
type CallRowNav = NativeStackNavigationProp<MessengerStackParamList>;

const CallLogRow = React.memo(function CallLogRow({
  row, navigation,
}: {row: Row; navigation: CallRowNav}) {
        /**
         * PDF item 08 — the emergency row.
         *
         * Its own branch rather than a variant of the call row, because the
         * tap does something categorically different: there is no
         * conversation to re-launch, so it RE-DIALS through the OS. Passing
         * this id to `launchCall` (what a shared branch would do) resolves no
         * peer and silently does nothing.
         */
        if (row.kind === 'emergency') {
          return (
            <TouchableOpacity
              style={styles.callRow}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={`Emergency call to ${row.name}, ${row.number}, ${row.time}. Tap to call again.`}
              onPress={() => {
                /**
                 * Re-dial — and RECORDED, like every other `tel:` hand-off.
                 *
                 * The first version deliberately skipped the record here to
                 * "avoid double-counting". That was wrong: calling the police
                 * again an hour later is a second emergency call, and a log
                 * that hides it is lying by omission. The immediate
                 * double-tap case — the only thing that actually needed
                 * handling — is already covered by the store's 15s dedupe.
                 *
                 * Keeping the rule uniform ("every tel: hand-off records")
                 * is also what lets `emergencyDialSites` scan for it without
                 * an exception list, and an exception list is how the next
                 * dial site quietly goes unlogged.
                 */
                recordEmergencyCall({
                  sanitised: row.number,
                  label: row.name === row.number ? undefined : row.name,
                  source: row.source,
                });
                // B-638 — the SAME visible fallback the card's chips got. Two
                // `tel:` sites in one file with opposite failure behaviour is
                // how a device with no dialler (a tablet, or the BlueStacks QA
                // fleet) silently does nothing while the log says a call was
                // placed.
                Linking.openURL(`tel:${row.number}`).catch(() => {
                  Alert.alert('Could not open the dialler', `Dial ${row.number} manually.`);
                });
              }}>
              <View style={[styles.avatar, styles.emergencyAvatar]}>
                <Icon name="phone-alert" size={20} color="#FF3B3B" />
              </View>
              <View style={styles.callInfo}>
                <View style={styles.emergencyNameRow}>
                  {/* flexShrink on the NAME, not the badge: the long service
                      label ("All services / Police / Ambulance / Fire")
                      truncates cleanly, while an un-shrinkable badge was
                      pushed off the screen edge and read "EMERGENC" —
                      founder screenshot 2026-08-24. */}
                  <Text style={[styles.callName, styles.emergencyName]} numberOfLines={1}>{row.name}</Text>
                  <View style={styles.emergencyBadge}>
                    <Text style={styles.emergencyBadgeText}>EMERGENCY</Text>
                  </View>
                </View>
                <View style={styles.callMeta}>
                  <Icon name="arrow-top-right" size={12} color="#FF3B3B" />
                  {/* The SOURCE and the NUMBER, because a label like "Police"
                      does not say what was actually dialled — and after an
                      incident that is the fact people need. No duration: the
                      OS never told us one. */}
                  <Text style={styles.callDuration}>
                    {SOURCE_LABEL[row.source]} · {row.number}
                  </Text>
                </View>
              </View>
              <Text style={styles.callTime}>{row.time}</Text>
            </TouchableOpacity>
          );
        }
        const c = row;
        const dirIcon = getDirectionIcon(c);
        const arrowIcon = getDirArrow(c);
        return (
          <TouchableOpacity
            style={styles.callRow}
            onPress={() => {
              // Tapping a call row re-launches the call against the
              // SAME conversation, mirroring WhatsApp. The previous
              // code mistakenly passed the call-record id as
              // conversationId, which didn't resolve any peer.

              const {launchCall} = require('@/modules/messenger/webrtc/launchCall') as typeof import('@/modules/messenger/webrtc/launchCall');
              launchCall(navigation as unknown as {navigate: (s: string, p?: Record<string, unknown>) => void}, {
                conversationId: c.conversationId,
                callType:       c.type,
              });
            }}
            activeOpacity={0.8}>

            {/* Avatar */}
            <UserAvatar
              userId={c.peerId}
              size={44}
              radius={c.rounded ? 22 : 13}
              fallback={
                <View style={[
                  styles.avatar,
                  {backgroundColor: c.bg},
                  !c.rounded && styles.avatarSquare,
                ]}>
                  {c.isGroup
                    ? <Icon name="earth" size={20} color="#A9C5FF" />
                    : <Text style={styles.avatarText}>{c.initials}</Text>
                  }
                </View>
              }
            />

            {/* Info */}
            <View style={styles.callInfo}>
              <Text style={styles.callName} numberOfLines={1}>{c.name}</Text>
              <View style={styles.callMeta}>
                <Icon name={dirIcon.name} size={13} color={dirIcon.color} />
                {c.direction === 'missed'
                  ? <Text style={styles.missedLabel}>Missed</Text>
                  : <>
                      {/* B-59 defence-in-depth: an answered row always shows a
                          MM:SS/0:00 duration in THIS slot. A zero/absent
                          duration used to render empty, leaving only the
                          right-column "Nm ago" age visible — which the tester
                          read as the "1M/2M/3M" call length. */}
                      <Text style={styles.callDuration}>{c.duration ?? '0:00'}</Text>
                      {arrowIcon && <Icon name={arrowIcon.name} size={12} color={arrowIcon.color} />}
                    </>
                }
                {c.isGroup && <Text style={styles.groupLabel}>Group · </Text>}
                {c.outcome === 'ended-by-host' && (
                  <Text style={styles.endedByHostLabel}>Ended by host</Text>
                )}
              </View>
            </View>

            {/* Right side */}
            <View style={styles.callRight}>
              <Text style={styles.callTime}>{c.time}</Text>
              <TouchableOpacity
                style={styles.callBtn}
                hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}
                onPress={() => {
                  // Same path as the row tap — launchCall resolves the
                  // peer from the conversation. The previous code passed
                  // the call-record id (c.id) as conversationId and
                  // navigated CallScreen directly, so no peer resolved
                  // and the call stuck in connecting. Mirror the row.
                  const {launchCall} = require('@/modules/messenger/webrtc/launchCall') as typeof import('@/modules/messenger/webrtc/launchCall');
                  launchCall(navigation as unknown as {navigate: (s: string, p?: Record<string, unknown>) => void}, {
                    conversationId: c.conversationId,
                    callType:       c.type,
                  });
                }}
                activeOpacity={0.7}>
                <Icon name="phone" size={18} color="#5B8DEF" />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        );

});

/**
 * The Calls-log BODY — the filter tabs + the scrollable list.
 *
 * Split out (N1) so the persistent-footer Messenger home can render it INLINE as
 * the `Calls` tab (`embedded`) without unmounting the bar, while the pushed
 * `CallsLog` route (missed-call deep-link / Links door) keeps rendering it
 * IDENTICALLY through the default export below. `embedded` drops the outer
 * safe-area padding + StatusBar (the host already owns them) and the back
 * chevron (a tab has nothing to pop); `bottomPad` clears the persistent bar.
 */
export function CallsLogBody({embedded = false, bottomPad = 0}: {embedded?: boolean; bottomPad?: number}) {
  const navigation = useNavigation<NativeStackNavigationProp<MessengerStackParamList>>();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<FilterTab>('all');
  // Round 6 / perf — subscribe ONLY to the call-message slice (already
  // filtered + sorted newest-first by selectCallMessages, memoised on
  // the live `messages` map). Previously this screen subscribed to the
  // entire `s.messages` map, so any append to ANY chat re-rendered the
  // call log. Now it only re-renders when an actual call bubble is
  // added/removed (the sort is stable across same-input identity, so
  // the frozen array reference is reused until the underlying map flips).
  const callMessages  = useMessengerStore(selectCallMessages);
  const conversations = useMessengerStore(s => s.conversations);

  // Build the row view-models. The selector handed us the filtered +
  // sorted message list; we still need the per-row name / direction
  // mapping, but that's pure transform.
  const calls: CallLog[] = useMemo(() => {
    const out: CallLog[] = [];
    for (const m of callMessages) {
      const meta = m.call_meta!;
      const convId = m.conversation_id;
      const conv = conversations[convId];
      const convName = conv?.name ?? (isDirectPrefixed(convId) ? peerFromDirectSlot(convId) : convId).slice(0, 8);
      const isGroup  = conv?.type === 'group';
      const ms = m.created_at ? Date.parse(m.created_at) : Date.now();
      const direction: CallLog['direction'] =
        meta.outcome === 'missed' || meta.outcome === 'declined' ? 'missed' :
        meta.direction === 'incoming' ? 'in' : 'out';
      out.push({
        id:             m.id,
        conversationId: convId,
        peerId:         isGroup ? null : (conv?.peer?.userId ?? null),
        name:           convName,
        initials:       initialsOf(convName),
        bg:             avatarBg(convId),
        rounded:        true,
        type:           meta.kind,
        direction,
        outcome:        meta.outcome,
        duration:       fmtDuration(meta.duration),
        time:           fmtRelative(ms),
        timestampMs:    ms,
        isGroup,
      });
    }
    return out;
  }, [callMessages, conversations]);

  /**
   * PDF item 08 — emergency rows, merged into the same list.
   *
   * "Emergency Calls must appear in the Calls Log ALONGSIDE normal voice and
   * video call history" — so they are interleaved by time, not parked in a
   * section of their own. "Visually identifiable" is the badge on the row.
   */
  const emergencyRecords = useEmergencyCallLog(s => s.records);
  const emergencies: EmergencyLog[] = useMemo(
    () => emergencyRecords.map(r => ({
      id: r.id,
      name: r.label ?? r.number,
      number: r.number,
      source: r.source,
      time: fmtRelative(r.at),
      timestampMs: r.at,
    })),
    [emergencyRecords],
  );

  /**
   * ONE list, newest first. Sorted AFTER the merge rather than concatenating
   * two sorted lists, because interleaving by time is the whole point — an
   * emergency call placed between two messenger calls belongs between them.
   */
  const visible: Row[] = useMemo(() => {
    const merged: Row[] = [
      ...calls.map(c => ({kind: 'call' as const, ...c})),
      // An emergency call is a VOICE call, so it shows under All and Voice.
      // It is never "missed" (the OS never tells us) and never video, so those
      // two filters exclude it rather than guessing.
      ...(filter === 'all' || filter === 'voice'
        ? emergencies.map(e => ({kind: 'emergency' as const, ...e}))
        : []),
    ];
    return merged
      .filter(r => {
        if (r.kind === 'emergency') {return true;}   // already filtered above
        if (filter === 'all') {return true;}
        if (filter === 'missed') {return r.direction === 'missed';}
        if (filter === 'voice') {return r.type === 'voice';}
        if (filter === 'video') {return r.type === 'video';}
        return true;
      })
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }, [calls, emergencies, filter]);

  /**
   * B-655 — stable list props. `FlatList` is a `PureComponent`; a fresh
   * `renderItem` closure or an inline `contentContainerStyle` object defeats
   * its prop diff and re-renders the whole mounted window on every body render.
   */
  const listContentStyle = useMemo(
    () => ({paddingBottom: insets.bottom + 24 + bottomPad}),
    [insets.bottom, bottomPad],
  );
  const renderRow = useCallback(
    ({item}: ListRenderItemInfo<Row>) => <CallLogRow row={item} navigation={navigation} />,
    [navigation],
  );

  // WhatsApp-style colored direction icons:
  //   • missed/declined → red phone-missed
  //   • outgoing answered → green outgoing-arrow
  //   • incoming answered → green incoming-arrow
  //   • failed → amber alert-triangle

  return (
    <View style={[styles.root, !embedded && {paddingTop: insets.top}]}>
      {!embedded && <StatusBar barStyle="light-content" backgroundColor={Colors.background} />}

      {/* Header */}
      <View style={styles.header}>
        {/* N1 — no back chevron when embedded as the persistent-bar Calls tab:
            there is nothing to pop, and a back here would pop MessengerHome. */}
        {!embedded && (
          <TouchableOpacity
            onPress={() => goBackOnce(navigation)}
            activeOpacity={0.7}
            hitSlop={{top: 8, left: 8, right: 8, bottom: 8}}
            style={{paddingRight: 12}}>
            <Icon name="arrow-left" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        )}
        <Text style={[styles.headerTitle, {flex: 1}]}>Calls</Text>
        {/**
         * B-638 (client, 2026-08-23) — the header carries NOTHING now.
         *
         * ⚠️ THIS REVERSES B-626 FROM THE DAY BEFORE, deliberately. B-626 turned
         * the emergency CARD into a header word "like Links"; the client's
         * screenshot of what they want shows the card back and **no emergency
         * word in the header at all**, so the card below replaces this door
         * rather than sitting beside it.
         *
         * LINKS is gone too, by explicit instruction ("just remove the button").
         * ⚠️ `LinksScreen` therefore has NO remaining entry point — this was its
         * only one. The ROUTE stays registered in both navigators
         * (`MessengerNavigator`, `AgentNavigator`), so nothing crashes and
         * restoring a door is a one-line change wherever it should live.
         */}
      </View>

      {/* B-638 — the emergency card, PINNED between the header and the filter
          tabs, exactly where the client drew it. Outside the ScrollView on
          purpose: the one affordance that must never need a scroll to find.
          It is also outside the filter, because an emergency is never
          "filtered out" by MISSED/VOICE/VIDEO. */}
      <EmergencyQuickDial onOpenDirectory={() => navigation.navigate('EmergencyServices')} />

      {/* Filter tabs */}
      <View style={styles.tabRow}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f.key}
            style={[styles.tab, filter === f.key && styles.tabActive]}
            onPress={() => setFilter(f.key)}
            activeOpacity={0.8}>
            <Text style={[styles.tabText, filter === f.key && styles.tabTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/**
       * B-655 — VIRTUALISED. Was a `ScrollView` + `visible.map(...)` that
       * mounted every row in the entire call history. That is what made the
       * 2026-08-24 "keep it mounted and toggle display" experiment so
       * expensive, and it is what makes the restored conditional mount cheap
       * again. The two changes are a PAIR — revert either alone and the
       * founder's lag comes back.
       */}
      <FlatList
        style={{flex: 1}}
        data={visible}
        keyExtractor={callRowKey}
        renderItem={renderRow}
        contentContainerStyle={listContentStyle}
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={7}
        removeClippedSubviews
        ListHeaderComponent={
          visible.length === 0 ? null : <Text style={styles.sectionLabel}>Recent Calls</Text>
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Icon name="phone-outline" size={44} color="rgba(180,188,204,0.45)" />
            <Text style={styles.emptyTitle}>No calls yet</Text>
            <Text style={styles.emptyHint}>
              Tap the phone or video icon in any chat to start a DTLS-SRTP encrypted call.
              Call history will appear here.
            </Text>
          </View>
        }
      />
    </View>
  );
}

/** The pushed `CallsLog` route (deep-link / Links door) — the standalone screen
 *  is the body under its own safe-area + back chevron. */
export default function CallsLogScreen() {
  return <CallsLogBody />;
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)'},
  headerTitle: {fontSize: 17, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 3, color: '#FFFFFF'},
  // B-638 — `linksBtn` / `linksText` / `linksBtnSpaced` / `emergencyText` were
  // deleted with the two header buttons they styled. Nothing else referenced
  // them (verified), so leaving them would have been dead weight knip flags.

  tabRow: {flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.09)'},
  tab: {flex: 1, alignItems: 'center', paddingVertical: 8, borderBottomWidth: 2, borderBottomColor: 'transparent'},
  tabActive: {borderBottomColor: '#5B8DEF'},
  tabText: {textAlign: 'center', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase', color: 'rgba(180,188,204,0.45)'},
  tabTextActive: {color: '#5B8DEF'},

  sectionLabel: {fontSize: 9, fontWeight: '800', letterSpacing: 3, textTransform: 'uppercase', color: 'rgba(180,188,204,0.45)', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8},

  callRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)'},
  avatar: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  avatarSquare: {borderRadius: 13},
  avatarText: {fontSize: 13, fontWeight: '700', color: '#FFF'},
  callInfo: {flex: 1, minWidth: 0},
  callName: {fontSize: 13, fontWeight: '700', color: '#FFFFFF', marginBottom: 4},
  callMeta: {flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0},
  callDuration: {fontSize: 11, color: 'rgba(229,233,242,0.62)'},
  missedLabel: {fontSize: 11, color: '#f87171', fontWeight: '600'},
  groupLabel: {flexShrink: 1, fontSize: 11, color: 'rgba(229,233,242,0.62)'},
  endedByHostLabel: {flexShrink: 1, minWidth: 0, fontSize: 11, color: 'rgba(229,233,242,0.62)', fontStyle: 'italic'},
  callRight: {alignItems: 'flex-end', gap: 4, flexShrink: 0},
  callTime: {fontSize: 10, color: 'rgba(180,188,204,0.45)'},
  // PDF item 08 — "Emergency calls should be visually identifiable so users can
  // distinguish them from standard communication history." Red is the signal,
  // but it is NOT the only one: the badge carries the word, so the row still
  // reads as an emergency to a colour-blind user and in a screenshot.
  emergencyAvatar: {backgroundColor: 'rgba(255,59,59,0.14)', borderWidth: 1, borderColor: 'rgba(255,59,59,0.45)'},
  emergencyNameRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4, minWidth: 0},
  // The half of the fix the badge's flexShrink:0 needs to work: without
  // flexShrink here the intrinsic-width name wins the layout fight and the
  // badge leaves the screen anyway.
  emergencyName: {flexShrink: 1, marginBottom: 0},
  emergencyBadge: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
    backgroundColor: 'rgba(255,59,59,0.16)', borderWidth: 1, borderColor: 'rgba(255,59,59,0.45)',
    // flexShrink so a long label squeezes the NAME (which truncates cleanly)
    // rather than pushing the badge off the row.
    flexShrink: 0,
  },
  emergencyBadgeText: {fontSize: 8, fontWeight: '800', color: '#FF6B6B', letterSpacing: 0.6},

  // 2026-08-24 — the pinned banner (chevron-only; the chips moved behind the
  // directory). Same red signal family as the logged emergency row, so "this
  // is the emergency surface" reads at a glance.
  emergencyCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    marginHorizontal: 16, marginTop: 14, marginBottom: 4, padding: 16, borderRadius: 16,
    backgroundColor: 'rgba(255,59,59,0.08)', borderWidth: 1, borderColor: 'rgba(255,59,59,0.28)',
  },
  emergencyTile: {
    width: 46, height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    // The screen's existing red family (#FF3B3B), not a new hue — G8.
    backgroundColor: '#F04444',
  },
  emergencyTitle: {fontSize: 15, fontWeight: '800', letterSpacing: 1.6, color: '#FFFFFF'},
  emergencySub: {fontSize: 12.5, color: 'rgba(229,233,242,0.72)', marginTop: 3, lineHeight: 17},

  callBtn: {width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center'},

  emptyWrap: {alignItems: 'center', paddingVertical: 64, paddingHorizontal: 32, gap: 12},
  emptyTitle: {color: '#F2F4F8', fontSize: 14, fontWeight: '700', marginTop: 8},
  emptyHint: {color: 'rgba(229,233,242,0.62)', fontSize: 11, textAlign: 'center', lineHeight: 16, maxWidth: 300},
}));
