/**
 * MissionStepper (Step 18 / B1) — the ONE mission progress bar, rendered identically on
 * client, agency, and CPO. Consumes the pure `journeyStep(booking, mission?)` helper and
 * renders the 6-step StepperBar, an SOS ribbon over the active step, and an honest banner
 * for the terminal side-states (Cancelled / No detail / Stood down). Metadata only — it
 * never reads or renders a decrypted Ops-Room message body.
 */
import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import StepperBar from '../ui/StepperBar';
import {UI} from '../ui/tokens';
import {journeyStep, STEP_LABELS, TOTAL_STEPS, type JourneyStep, type SideState} from '@screens/booking/missionJourney';
import {scaleTextStyles} from '@utils/scaling';

interface Props {
  booking: {status: string | null | undefined};
  mission?: {status: string | null | undefined} | null;
  /** Pre-computed step (e.g. after a monotonic clamp across polls) — overrides booking/mission. */
  step?: JourneyStep;
}

const SIDE: Record<SideState, {icon: string; tint: string; title: string; body: string}> = {
  CANCELLED:   {icon: 'close-circle-outline', tint: UI.alert, title: 'Booking cancelled', body: 'This detail was cancelled.'},
  NO_PROVIDER: {icon: 'magnify-close',        tint: UI.amber, title: 'No detail available', body: 'No agency could take this right now — you were not charged.'},
  ABORTED:     {icon: 'shield-off-outline',   tint: UI.amber, title: 'Crew stood down', body: 'Reassigning your detail to another agency.'},
};

/** Rail forms of STEP_LABELS, in the same order. */
const SHORT_STEPS = ['Searching', 'Accepted', 'Dispatch', 'En route', 'Active', 'Done'] as const;

export default function MissionStepper({booking, mission, step}: Props) {
  const j = step ?? journeyStep(booking, mission);

  if (j.sideState) {
    const side = SIDE[j.sideState];
    return (
      <View style={[s.banner, {borderColor: `${side.tint}55`, backgroundColor: `${side.tint}14`}]}>
        <Icon name={side.icon as never} size={20} color={side.tint} />
        <View style={{flex: 1}}>
          <Text style={[s.bannerTitle, {color: side.tint}]}>{side.title}</Text>
          <Text style={s.bannerBody}>{side.body}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={s.wrap}>
      {j.sos && (
        <View style={s.sos}>
          <Icon name="alarm-light" size={15} color={UI.alert} />
          <Text style={s.sosText}>SOS ACTIVE — emergency response engaged</Text>
        </View>
      )}
      <StepperBar
        steps={STEP_LABELS}
        activeIndex={j.index}
        tint={UI.accent}
        // The stage NAME lives here now — full width, never truncated. Six
        // labels cannot be made readable across a 320dp rail (see StepperBar).
        caption={j.index > 0 ? `Step ${j.index} of ${TOTAL_STEPS} · ${j.label}` : j.label}
        // One-word forms so all six stages stay visible at normal text size.
        // Derived here, NOT by editing STEP_LABELS — those strings are the
        // shared client/agency/CPO copy and are pinned by agentAcceptance.
        shortSteps={SHORT_STEPS}
      />
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  wrap: {gap: 10},
  sos: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'rgba(255,93,93,0.12)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.35)',
  },
  sosText: {fontFamily: UI.fBold, fontSize: 10, letterSpacing: 0.6, color: UI.alert},
  banner: {flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, borderRadius: 14, borderWidth: 1},
  bannerTitle: {fontFamily: UI.fBold, fontSize: 14},
  bannerBody: {fontFamily: UI.fSans, fontSize: 12, lineHeight: 17, color: UI.textDim, marginTop: 2},
}));
