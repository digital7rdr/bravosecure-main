/**
 * Peer presence UI primitives.
 *
 * Two pieces:
 *   • PeerPresencePill   — green/amber/grey chip with a pulsing dot when
 *                          the peer is online. Used in chat headers + call
 *                          screens to give a quick presence read at a glance.
 *   • PeerOfflineBanner  — full-width banner shown above the message list
 *                          (or behind a calling state) when the peer is
 *                          offline. Friendly tone, includes the last-seen
 *                          relative timestamp when we have one.
 *
 * Both are presentation-only — they consume a `{online, lastSeen?}` record
 * (the same shape the messengerStore.peerPresence map produces) and never
 * touch the store directly. Group chats have no single peer, so callers
 * should skip rendering these for `type === 'group'` conversations.
 */
import React, {useEffect, useRef} from 'react';
import {View, Text, StyleSheet, Animated, Easing, Platform} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

export interface PresenceRec {
  online:    boolean;
  /** Full 4-state presence from the store; optional for legacy callers. */
  state?:    'online' | 'active' | 'away' | 'offline';
  lastSeen?: number;          // epoch ms
}

const C = {
  online:  '#00C853',
  away:    '#F59E0B',
  recent:  '#FFC107',
  offline: '#7E8AA6',
  bg:      'rgba(6,20,43,0.85)',
  bd:      '#1C3B66',
  err:     '#FF3B3B',
  tx1:     '#FFFFFF',
  tx2:     '#B8C7E0',
  tx3:     '#7E8AA6',
};

const MONO = Platform.select({ios: 'Menlo', default: 'monospace'});

/**
 * Friendly "5 min ago" / "yesterday" / "Apr 29" style.
 */
export function formatLastSeen(epochMs?: number): string | null {
  if (!epochMs) {return null;}
  const ms = Date.now() - epochMs;
  if (ms < 0)               {return null;}
  if (ms < 60_000)          {return 'just now';}
  if (ms < 3_600_000)       {return `${Math.floor(ms / 60_000)}m ago`;}
  if (ms < 86_400_000)      {return `${Math.floor(ms / 3_600_000)}h ago`;}
  if (ms < 7 * 86_400_000)  {return `${Math.floor(ms / 86_400_000)}d ago`;}
  // Why: "Apr 29" is ambiguous once the calendar rolls over — include the
  // year for prior-year dates (WhatsApp style). Current year is derived from
  // Date.now(), not `new Date()`, so a mocked clock stays consistent.
  const at = new Date(epochMs);
  const sameYear = at.getFullYear() === new Date(Date.now()).getFullYear();
  return at.toLocaleDateString(undefined, sameYear
    ? {month: 'short', day: 'numeric'}
    : {year: 'numeric', month: 'short', day: 'numeric'});
}

/**
 * Four-tier presence: online, away (idle/backgrounded), recent (within
 * 5 minutes of last-seen), offline. Splits "offline" into two visual
 * flavours so the user sees "active recently" vs "long gone" without
 * reading the timestamp.
 */
function tier(rec?: PresenceRec): 'online' | 'away' | 'recent' | 'offline' {
  if (!rec) {return 'offline';}
  // Why: PRES-02 — the store derives online = state !== 'offline', so an
  // 'away' peer read as green "Online" while the avatar dot showed amber.
  if (rec.state === 'away') {return 'away';}
  if (rec.online) {return 'online';}
  // B-147 — the window must be bounded at BOTH ends. `delta < 5min`
  // alone accepts a NEGATIVE delta, so a peer whose clock ran ahead
  // (or a server stamping a future ts) read as "Active recently" while
  // actually offline — and, worse, suppressed PeerOfflineBanner
  // entirely, since the banner only paints for tier 'offline'.
  // formatLastSeen already rejects the same timestamp (`ms < 0`), so
  // the pill claimed recent activity with no timestamp beside it: two
  // functions disagreeing about one record.
  if (rec.lastSeen !== undefined) {
    const sinceMs = Date.now() - rec.lastSeen;
    if (sinceMs >= 0 && sinceMs < 5 * 60_000) {return 'recent';}
  }
  return 'offline';
}

// ─── PeerPresencePill ─────────────────────────────────────────────

interface PillProps {
  presence?: PresenceRec;
  /** Optional override label — defaults to "Online" / "Away" / "Active recently" / "Offline". */
  label?:    string;
  /** When true, renders compact (icon + tiny dot only, no text). */
  compact?:  boolean;
}

export function PeerPresencePill({presence, label, compact}: PillProps): React.ReactElement {
  const t = tier(presence);
  const color =
    t === 'online' ? C.online :
    t === 'away'   ? C.away :
    t === 'recent' ? C.recent : C.offline;
  const finalLabel = label ?? (
    t === 'online' ? (presence?.state === 'active' ? 'Active now' : 'Online') :
    t === 'away'   ? 'Away' :
    t === 'recent' ? 'Active recently' :
    formatLastSeen(presence?.lastSeen) ? `Last seen ${formatLastSeen(presence?.lastSeen)}` : 'Offline'
  );
  return (
    <View style={[s.pill, {borderColor: hexA(color, 0.4), backgroundColor: hexA(color, 0.12)}]}>
      <PulseDot color={color} active={t === 'online'} />
      {!compact && <Text style={[s.pillTxt, {color: t === 'online' ? '#FFF' : C.tx2}]} numberOfLines={1}>{finalLabel}</Text>}
    </View>
  );
}

// ─── PeerOfflineBanner ────────────────────────────────────────────

interface BannerProps {
  presence?: PresenceRec;
  /** Tone variant — `chat` for a soft top-strip; `call` for a warning banner before connecting. */
  variant?:  'chat' | 'call';
  peerName?: string;
}

export function PeerOfflineBanner({presence, variant = 'chat', peerName}: BannerProps): React.ReactElement | null {
  const isCall = variant === 'call';
  // Round 8 / false-active audit mitigation — the call-variant banner
  // ("They may be offline") reads as a hard warning to users mid-dial.
  // The presence reaper + reconnect-clear can both flip the peer to
  // `offline` for ~1 RTT before the server snapshot repaints; without
  // a grace window the banner strobes during ringing on every minor
  // blip. 4s is enough to swallow the snapshot round-trip but short
  // enough that a genuinely offline peer is still flagged before the
  // call-out gives up. Chat variant is unaffected — it has all day.
  const [graced, setGraced] = React.useState(!isCall);
  useEffect(() => {
    if (!isCall) {return;}
    const t = setTimeout(() => setGraced(true), 4000);
    return () => clearTimeout(t);
  }, [isCall]);
  const t = tier(presence);
  // Why: any non-offline tier (incl. 'away') must not paint the offline banner.
  if (t !== 'offline') {return null;}
  if (!graced) {return null;}
  const lastSeen = formatLastSeen(presence?.lastSeen);
  const bg = isCall ? hexA(C.err, 0.12) : hexA(C.offline, 0.10);
  const bd = isCall ? hexA(C.err, 0.45) : C.bd;
  const fg = isCall ? '#FFB3B3' : C.tx2;
  return (
    <View style={[s.banner, {backgroundColor: bg, borderColor: bd}]}>
      <Icon
        name={isCall ? 'wifi-off' : 'cloud-off-outline'}
        size={isCall ? 18 : 14}
        color={fg}
      />
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={[s.bannerTitle, {color: fg}]} numberOfLines={1}>
          {isCall
            ? `${peerName ?? 'They'} may be offline`
            : `${peerName ?? 'They'} are offline`}
        </Text>
        {lastSeen && (
          <Text style={[s.bannerSub, {color: hexA(fg, 0.85)}]} numberOfLines={1}>
            {isCall ? 'They’ll get a missed-call notification.' : `Last seen ${lastSeen}`}
          </Text>
        )}
      </View>
    </View>
  );
}

// ─── PulseDot ────────────────────────────────────────────────────
// 8px circle that gently pulses (scale 1 → 1.4 → 1, opacity 1 → 0)
// when active=true. Uses Animated.loop so the animation is offloaded
// from the JS thread once per render.

function PulseDot({color, active}: {color: string; active: boolean}): React.ReactElement {
  const ring = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {ring.setValue(0); return;}
    const loop = Animated.loop(
      Animated.timing(ring, {toValue: 1, duration: 1600, easing: Easing.out(Easing.ease), useNativeDriver: true}),
    );
    loop.start();
    return () => loop.stop();
  }, [active, ring]);
  return (
    <View style={s.dotWrap}>
      {active && (
        <Animated.View
          style={[
            s.dotRing,
            {
              borderColor: color,
              opacity: ring.interpolate({inputRange: [0, 1], outputRange: [0.7, 0]}),
              transform: [{scale: ring.interpolate({inputRange: [0, 1], outputRange: [1, 1.7]})}],
            },
          ]}
        />
      )}
      <View style={[s.dotCore, {backgroundColor: color}]} />
    </View>
  );
}

// ─── helpers ─────────────────────────────────────────────────────

function hexA(hex: string, a: number): string {
  // Convert #RRGGBB to rgba(...,a)
  if (hex.startsWith('rgba')) {return hex;}
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 99, borderWidth: 1,
    alignSelf: 'flex-start',
    // Why: long labels ("Last seen 13h ago") must ellipsize inside the
    // header's name column instead of rendering over the call buttons.
    flexShrink: 1, minWidth: 0,
  },
  pillTxt: {fontSize: 11, fontWeight: '700', letterSpacing: 0.3, fontFamily: MONO, flexShrink: 1},

  dotWrap: {width: 10, height: 10, alignItems: 'center', justifyContent: 'center'},
  dotCore: {width: 8, height: 8, borderRadius: 4},
  dotRing: {position: 'absolute', width: 10, height: 10, borderRadius: 5, borderWidth: 1.5},

  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 12, borderWidth: 1,
    marginHorizontal: 12, marginVertical: 8,
  },
  bannerTitle: {fontSize: 13, fontWeight: '700'},
  bannerSub:   {fontSize: 11, marginTop: 2},
});
