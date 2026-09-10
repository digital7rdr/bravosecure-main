/**
 * Department Chat v2 — shared obsidian UI kit.
 *
 * Matches the Bravo Secure Home / Booking Home design language (obsidian
 * #07090D base + platinum-cobalt #5B8DEF accent, edge-lit cards, BravoFont,
 * AmbientBg), NOT the legacy Command-Navy agent `_shared.tsx`. New attendance +
 * incident screens compose these primitives so the whole module reads as one
 * premium near-black surface.
 */
import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, type ImageSourcePropType, type StyleProp, type ViewStyle} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import {isInDepartmentalShell} from '@navigation/departmentalEntry';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import ImageryBackdrop, {type ImageryVariant} from '@components/ui/ImageryBackdrop';

/**
 * B-156 — true when this screen is nested inside the Departmental 5-tab shell
 * (Home · Channels · Attend · Incident · Vault). ObsidianTabBar renders
 * directly below the active tab's stack and already reserves `insets.bottom`;
 * a fixed-bottom footer on a pushed screen that ALSO adds `insets.bottom`
 * double-counts the safe area and opens a dead gap above the tab bar. Every
 * screen with a `footer`-style fixed bottom bar should use this to drop the
 * redundant reservation WITHOUT hiding the tab bar (hiding it outright is
 * only correct for a full chat thread — see DepartmentChatScreen, which
 * hides it because a composer, not a footer button, owns that space).
 * Same screens are also reachable standalone (pushed from MessengerHome with
 * no tab shell around them), where the full `insets.bottom` is still needed.
 */
export function useInDepartmentalShell(): boolean {
  const navigation = useNavigation<any>();
  // R8-4 — ONE predicate, not two with different semantics. This used to be a
  // single-level `getParent()` probe, which is literally the pattern
  // `findNavigatorWithRoute`'s docblock says it replaces: it reads false in any
  // shell nesting deeper than the case it was written for. Both were correct at
  // every current mount point, so the divergence was latent rather than broken
  // — but a deeper mount would have made this hook and the resolver disagree
  // about the same question, and the padding would silently double-count again.
  return isInDepartmentalShell(navigation);
}

// Obsidian palette (Bravo Secure Home handoff). Single source for the module.
export const OB = {
  bg:         '#07090D',
  card:       'rgba(22,27,37,0.72)',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  glow:       '#A9C5FF',
  amber:      '#E2C893',
  signal:     '#4ADE80',
  alert:      '#F58B97',
  /**
   * UI corrections 2026-08-15 item 03 — "Each Level should be colour coded to
   * easily distinguish hierarchy."
   *
   * ONE tuple, indexed by tier-1, and nowhere else in the app. The PDF's example
   * palette is gold / teal / blue / purple and says it "can be refined to the
   * Bravo brand" — so two of the four are EXISTING brand tokens reused
   * (`amber`, `accentSoft`) and only teal and purple are new. That is the
   * minimum possible extension of a locked palette, which DESIGN_REVIEW_LOOP G8
   * otherwise makes an automatic Major.
   *
   * MEASURED contrast against the obsidian surface `#07090D`:
   *   L1 #E2C893  12.26:1     L2 #7FD8CB  11.94:1
   *   L3 #A9C5FF  11.50:1     L4 #CB9BF5   9.06:1
   * All four clear 4.5:1 body and 3:1 UI. Hue separations are 131° / 49° / 52°.
   *
   * ⚠️ COLOUR IS NEVER THE ONLY SIGNAL. Each level row also carries an "Ln" pill,
   * an indent and a branch connector, because L2→L3→L4 are the tight pairs under
   * deuteranopia and a tier a colour-blind user cannot read is not colour-coded.
   *
   * ⚠️ KEEP THESE HEX. `ManageChannelsScreen`'s badge does raw hex-alpha concat
   * (`color + '4D'`), which produces garbage for an `rgba()` string.
   */
  level: ['#E2C893', '#7FD8CB', '#A9C5FF', '#CB9BF5'] as const,
} as const;

/** Tier 1..4 → its colour. Out-of-range clamps rather than returning undefined,
 *  which would silently render an uncoloured "level" row. */
export function levelTint(tier: number): string {
  return OB.level[Math.min(Math.max(tier, 1), OB.level.length) - 1];
}

type IconName = React.ComponentProps<typeof Icon>['name'];

// 1px top edge-light across the top of every premium card.
export function EdgeLight() {
  return (
    <LinearGradient
      colors={['transparent', 'rgba(255,255,255,0.13)', 'transparent']}
      start={{x: 0, y: 0}}
      end={{x: 1, y: 0}}
      style={k.edgeLight}
      pointerEvents="none"
    />
  );
}

export function ObHeader({
  title, onBack, pill, pillTone = 'default',
}: {
  title: string;
  onBack?: () => void;
  pill?: string;
  pillTone?: 'default' | 'warn' | 'good';
}) {
  const tone = pillTone === 'warn' ? OB.amber : pillTone === 'good' ? OB.signal : OB.accentSoft;
  // BB-7 (2026-08-15 back audit) — every deptchat screen wires onBack as a
  // bare navigation.goBack() and none imports goBackOnce, so a double-tap
  // inside the pop animation dispatched a second GO_BACK that bubbled to the
  // tab router and threw the user to Home (the B-261 class). Guarded here, at
  // the ONE component all of them share, instead of at 26 call sites.
  const lastBackTapRef = React.useRef(0);
  const handleBack = onBack === undefined ? undefined : () => {
    const now = Date.now();
    if (now - lastBackTapRef.current < 600) {return;}
    lastBackTapRef.current = now;
    onBack();
  };
  return (
    <View style={k.header}>
      {handleBack ? (
        <TouchableOpacity
          style={k.back}
          onPress={handleBack}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={OB.text} />
        </TouchableOpacity>
      ) : <View style={{width: 36}} />}
      <Text style={k.headerTitle} numberOfLines={1}>{title}</Text>
      {pill ? (
        <View style={[k.pill, {borderColor: tone + '4D', backgroundColor: tone + '1A'}]}>
          <Text style={[k.pillText, {color: tone}]}>{pill}</Text>
        </View>
      ) : <View style={{width: 36}} />}
    </View>
  );
}

export function SectionLabel({children, right, numberOfLines, style}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  /** Extra layout on the header row — spacing above, mostly. */
  style?: StyleProp<ViewStyle>;
  /**
   * For a label built from DATA rather than a constant. The style is uppercase
   * mono with letter-spacing, so a 200-character organisation name wraps to a
   * dozen lines and pushes its own content off screen.
   */
  numberOfLines?: number;
}) {
  return (
    <View style={[k.sectionHeader, style]}>
      <Text style={k.sectionLabel} numberOfLines={numberOfLines}>{children}</Text>
      {right}
    </View>
  );
}

export function Card({children, style, onPress, accessibilityLabel, img, imgVariant}: {
  children: React.ReactNode;
  style?: object;
  onPress?: () => void;
  /** Brand art behind the card (founder drop 2026-08-31). Rendered UNDER the
   *  EdgeLight so the card keeps its top hairline, and decorative-only — the
   *  backdrop hides itself from the screen reader. */
  img?: ImageSourcePropType;
  imgVariant?: ImageryVariant;
  /** A pressable Card IS a button. Without a label its only accessible name is
   *  whatever text sits inside it — which for an icon-led row can be nothing.
   *  Ignored on the non-pressable branch, where a Card is a container. */
  accessibilityLabel?: string;
}) {
  const body = (
    <>
      {!!img && <ImageryBackdrop source={img} variant={imgVariant ?? 'card'} radius={18} />}
      <EdgeLight />
      {children}
    </>
  );
  if (onPress) {
    return (
      <TouchableOpacity style={[k.card, style]} activeOpacity={0.85} onPress={onPress}
        accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
        {body}
      </TouchableOpacity>
    );
  }
  return <View style={[k.card, style]}>{body}</View>;
}

export function PrimaryButton({
  label, icon, onPress, disabled, busy,
}: {
  label: string;
  icon?: IconName;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR, not a nullish default
  const off = disabled || busy;
  return (
    <TouchableOpacity activeOpacity={0.85} disabled={off} onPress={onPress}>
      <LinearGradient
        colors={off ? ['#2A3342', '#222936'] : ['#6E9BF5', OB.accent, OB.accentDeep]}
        locations={[0, 0.55, 1]}
        start={{x: 0.1, y: 0}}
        end={{x: 0.9, y: 1}}
        style={[k.primaryBtn, off && k.primaryBtnOff]}>
        {busy ? (
          <ActivityIndicator color="#FFF" />
        ) : (
          <>
            {icon && <Icon name={icon} size={18} color={off ? OB.textMute : '#FFF'} />}
            {/* One line, and it shrinks. The button is a FIXED 56dp row, so a
                label longer than the width wrapped and was clipped — which
                nothing noticed while every label was two short words. Labels
                now carry data (a company and a site name), so the constraint
                belongs on the shared button, not on each caller. */}
            <Text
              style={[k.primaryBtnText, off && {color: OB.textMute}]}
              numberOfLines={1}>
              {label}
            </Text>
          </>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
}

export function GhostButton({label, icon, onPress, disabled}: {
  label: string; icon?: IconName; onPress?: () => void; disabled?: boolean;
}) {
  return (
    <TouchableOpacity style={[k.ghostBtn, disabled && {opacity: 0.5}]} activeOpacity={0.8}
      disabled={disabled} onPress={onPress}>
      {icon && <Icon name={icon} size={16} color={OB.accentSoft} />}
      <Text style={k.ghostBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * F15 — turn a failed list load into words a user (and a field tester) can act on.
 *
 * Every Enterprise list used to `catch { setX([]) }`, so "403, you are not a
 * member of this org" and "nothing here yet" rendered the SAME empty state.
 * That is not a cosmetic gap: it is what makes every other bug in this module
 * get misdiagnosed, because the screen reports success while the request failed.
 *
 * Status-first, message-second: the server's own `message` is a code
 * (`user_not_found`, `cpo_not_active_member_of_org`) meant for a switch, not for
 * a human, so it is only used when nothing better is known.
 *
 * NO STATUS AT ALL is the offline case — axios rejects without a `response` —
 * and it must not be reported as a server error, because the two have different
 * fixes ("check your network" vs "ask an admin").
 */
export function loadErrorText(e: unknown): string {
  const err = e as {response?: {status?: number; data?: {message?: string}}; message?: string};
  const status = err?.response?.status;
  if (status === undefined) {
    return 'No connection to Bravo. Check your network, then try again.';
  }
  if (status === 401 || status === 403) {
    return 'You do not have access to this. If you have just joined a workspace, an admin still has to approve you.';
  }
  if (status === 404) {
    return 'This is not available on your account.';
  }
  if (status >= 500) {
    return 'Bravo could not answer that request. Please try again in a moment.';
  }
  return err?.response?.data?.message ?? err?.message ?? 'That request could not be completed.';
}

/**
 * The one failure surface for every Enterprise list. Deliberately a `Card` from
 * this same kit rather than a new visual language (DESIGN_REVIEW_LOOP G8), and
 * deliberately DISTINCT from the empty states next to it — a shared component is
 * what stops the next list from inventing its own silent `catch`.
 */
export function ErrorState({message, onRetry, busy}: {
  message: string;
  onRetry?: () => void;
  /**
   * A retry with no acknowledgement is a dead press, and offline it stays dead
   * for the whole request timeout — the user taps, the identical card
   * re-renders, and they conclude the button is broken. Callers that flip a
   * loading flag on retry must say so HERE: the flag cannot show through,
   * because this card is rendered INSTEAD of the content the flag gates.
   */
  busy?: boolean;
}) {
  return (
    <Card style={k.errorCard}>
      <View style={k.errorHead}>
        <Icon name="alert-circle-outline" size={18} color={OB.alert} />
        <Text style={k.errorTitle}>Could not load</Text>
      </View>
      <Text style={k.errorText}>{message}</Text>
      {onRetry ? (
        busy
          ? <ActivityIndicator color={OB.accentSoft} style={{alignSelf: 'flex-start', marginTop: 4}} />
          : <GhostButton label="Try again" icon="refresh" onPress={onRetry} />
      ) : null}
    </Card>
  );
}

// Attendance status → label + colour, shared by the result + history surfaces.
export function attendanceStatusMeta(status?: string | null): {label: string; color: string; icon: IconName} {
  switch (status) {
    case 'present':        return {label: 'Present', color: OB.signal, icon: 'check-circle'};
    case 'late':           return {label: 'Late', color: OB.amber, icon: 'clock-alert-outline'};
    case 'early_checkout': return {label: 'Early checkout', color: OB.amber, icon: 'clock-end'};
    case 'absent':         return {label: 'Absent', color: OB.alert, icon: 'close-circle-outline'};
    case 'leave':          return {label: 'Leave', color: OB.accentSoft, icon: 'beach'};
    case 'sick_leave':     return {label: 'Sick leave', color: OB.accentSoft, icon: 'pill'};
    case 'off_duty':       return {label: 'Off duty', color: OB.textMute, icon: 'sleep'};
    // A7.3 — the two statuses the PDF requires beyond the original four.
    case 'emergency_leave': return {label: 'Emergency leave', color: OB.alert, icon: 'ambulance'};
    case 'mission':        return {label: 'Mission', color: OB.accentSoft, icon: 'shield-airplane'};
    case 'pending_review': return {label: 'Pending review', color: OB.amber, icon: 'shield-alert-outline'};
    default:               return {label: 'Open', color: OB.accentSoft, icon: 'clock-outline'};
  }
}

// Channels Hub v2 per-channel state label (PDF p.4 mockup: Read only / Private /
// Active / Admin / Managers / Archive). Derived from type + access (+ the
// viewer's role / archived flag) so one helper feeds the hub and the manage list.
export function channelStateMeta(input: {
  channel_type?: 'board' | 'department' | 'incident' | null;
  access?: 'standard' | 'read_only' | 'restricted' | null;
  /** Scope v2 Phase 2 — POSTING rights. The "Read only" badge is a POSTING
   *  statement and must come from here, not from `access`.
   *
   *  This helper used to answer it from `access === 'read_only'`. Phase 2 then
   *  made that value unwritable — Standard and Read only both store
   *  `access: 'standard'` and differ only in post_mode — so the badge went DEAD
   *  in the very phase whose purpose was to make read-only real, and a legacy
   *  row lost its badge the first time anyone pressed Save. Same visibility/
   *  posting re-merge as the server had, on the client surface. */
  post_mode?: 'open' | 'read_only' | 'announcement' | 'admin_only' | null;
  is_broadcast?: boolean;
  my_role?: 'admin' | 'viewer';
  archived?: boolean;
}): {label: string; color: string} {
  if (input.archived) {return {label: 'Archive', color: OB.textMute};}
  if (input.is_broadcast) {return {label: 'Broadcast', color: OB.amber};}
  if (input.channel_type === 'incident') {return {label: 'Managers', color: OB.amber};}
  // POSTING — anything that is not open chat reads as read-only to a member.
  // `access === 'read_only'` is kept only so pre-Phase-2 rows still badge.
  if (input.post_mode === 'announcement') {return {label: 'Announce', color: OB.textMute};}
  if ((input.post_mode && input.post_mode !== 'open') || input.access === 'read_only') {
    return {label: 'Read only', color: OB.textMute};
  }
  // VISIBILITY.
  if (input.access === 'restricted') {return {label: 'Private', color: OB.amber};}
  if (input.my_role === 'admin') {return {label: 'Admin', color: OB.accentSoft};}
  return {label: 'Active', color: OB.signal};
}

export function reviewReasonLabel(reason?: string | null): string | null {
  switch (reason) {
    case 'face_mismatch':      return 'Face check could not be confirmed';
    case 'camera_unavailable': return 'Camera unavailable or not allowed';
    case 'out_of_radius':      return 'Outside the approved site radius';
    case 'permission_denied':  return 'Location was not shared';
    case 'offline':            return 'Submitted offline';
    case 'disputed':           return 'Disputed by the member';
    default:                  return null;
  }
}

const k = StyleSheet.create(scaleTextStyles({
  edgeLight: {position: 'absolute', top: 0, left: 16, right: 16, height: 1},

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 10,
  },
  back: {
    width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  /**
   * B-657 — `minWidth: 0` is LOAD-BEARING, not redundant with `flex: 1`.
   *
   * A flex child defaults to `min-width: auto`, which floors it at its CONTENT
   * width. Without this, the `flex: 1` is inert: a long unbreakable title (a
   * user-named workspace or channel) makes this column refuse to shrink and
   * pushes the trailing pill off the right edge. It is the same pair documented
   * in `messenger/__tests__/messengerHeaderFit.test.ts`.
   *
   * This header is shared by ~27 screens, so the one line covers all of them.
   */
  headerTitle: {
    flex: 1, minWidth: 0, textAlign: 'center', color: OB.text,
    fontFamily: BravoFont.extraBold, fontSize: 15, letterSpacing: 0.4,
  },
  pill: {minWidth: 36, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7, borderWidth: 1, alignItems: 'center'},
  pillText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1},

  sectionHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12},
  sectionLabel: {
    color: OB.textDim, fontFamily: BravoFont.mono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase',
  },

  card: {
    borderRadius: 18, padding: 16, backgroundColor: OB.card,
    borderWidth: 1, borderColor: OB.hair, overflow: 'hidden',
  },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    height: 56, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: OB.accent, shadowOffset: {width: 0, height: 12}, shadowOpacity: 0.4,
    shadowRadius: 24, elevation: 8,
  },
  primaryBtnOff: {borderColor: 'rgba(255,255,255,0.06)', shadowOpacity: 0},
  primaryBtnText: {color: '#FFF', fontFamily: BravoFont.bold, fontSize: 16, letterSpacing: 0.2,
    flexShrink: 1},

  ghostBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 50, borderRadius: 14, borderWidth: 1, borderColor: OB.hair2,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  ghostBtnText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 14},

  errorCard: {gap: 12, borderColor: 'rgba(245,139,151,0.28)'},
  errorHead: {flexDirection: 'row', alignItems: 'center', gap: 8},
  errorTitle: {color: OB.alert, fontFamily: BravoFont.bold, fontSize: 14},
  errorText: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, lineHeight: 18},
}));
