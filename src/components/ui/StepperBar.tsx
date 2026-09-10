/**
 * StepperBar (Step 18 / B3) — generic horizontal step indicator: numbered dots joined by
 * connectors, filled up to `activeIndex` (1-based; 0 = nothing reached). RTL-aware (the
 * track reverses under I18nManager.isRTL) and text-scale-aware. Presentational + prop-driven;
 * MissionStepper is the mission-specific consumer.
 */
import React from 'react';
import {View, Text, StyleSheet, PixelRatio} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {UI} from './tokens';
import {scaleTextStyles} from '@utils/scaling';
import {isRTL, rowDirection} from '@utils/rtl';

export interface StepperBarProps {
  steps: readonly string[];
  /** 1-based index of the current/last-reached step; 0 means none reached. */
  activeIndex: number;
  tint?: string;
  /** Render the current dot in an error tint (terminal side-state). */
  errored?: boolean;
  /**
   * One full-width line under the rail naming where the mission is. This is
   * where the step's WORDS live now — see the note on `cell` below.
   */
  caption?: string;
  /**
   * Optional one-word form of each step. Rendered under its dot ONLY when the
   * text can fit without wrapping (see RAIL_LABEL_MAX_FONT_SCALE) — so all six
   * stages are visible at normal text size, and at large text the rail falls
   * back to dots plus the caption rather than clipping mid-word.
   */
  shortSteps?: readonly string[];
}

/** Above this OS font scale, six labels cannot fit a phone-width rail. */
const RAIL_LABEL_MAX_FONT_SCALE = 1.2;

export default function StepperBar({
  steps, activeIndex, tint = UI.accent, errored = false, caption, shortSteps,
}: StepperBarProps) {
  const railLabels = shortSteps && PixelRatio.getFontScale() < RAIL_LABEL_MAX_FONT_SCALE
    ? shortSteps
    : null;
  const rtl = isRTL();
  const order = rtl ? steps.map((_, i) => steps.length - 1 - i) : steps.map((_, i) => i);
  return (
    <View style={s.wrap}>
    <View style={[s.row, {flexDirection: rowDirection()}]}>
      {order.map((stepIdx, pos) => {
        const n = stepIdx + 1;
        // The terminal step has no "next" state to be mid-way toward — once
        // reached it IS done, so render it filled like every prior step
        // instead of the hollow "current" ring (which reads as still in
        // progress and left the Completed dot looking un-filled).
        const isLast = n === steps.length;
        const done = n < activeIndex || (isLast && n === activeIndex);
        const current = n === activeIndex && !isLast;
        const dotColor = errored && current ? UI.alert : done || current ? tint : 'rgba(255,255,255,0.10)';
        const showConnector = pos < steps.length - 1;
        return (
          <React.Fragment key={n}>
            <View
              style={s.cell}
              accessible
              accessibilityRole="text"
              accessibilityLabel={`Step ${n} of ${steps.length}, ${steps[stepIdx]}${current ? ', current' : done ? ', done' : ''}`}>
              <View style={[s.dot, {borderColor: dotColor, backgroundColor: done ? dotColor : 'transparent'}]}>
                {done
                  ? <Icon name="check" size={12} color={UI.bg} />
                  : <Text style={[s.dotNum, {color: current ? dotColor : UI.textMute}]}>{n}</Text>}
              </View>
              {!!railLabels?.[stepIdx] && (
                <Text
                  numberOfLines={1}
                  style={[s.railLabel, current && {color: UI.text}]}>
                  {railLabels[stepIdx]}
                </Text>
              )}
            </View>
            {showConnector && <View style={[s.conn, {backgroundColor: n < activeIndex ? tint : 'rgba(255,255,255,0.10)'}]} />}
          </React.Fragment>
        );
      })}
    </View>
    {!!caption && (
      <Text style={s.caption} maxFontSizeMultiplier={1.4}>{caption}</Text>
    )}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  wrap: {gap: 8},
  row: {flexDirection: 'row', alignItems: 'center'},
  /**
   * Dots only. The labels used to sit under each dot in a FIXED 52dp cell, which
   * `scaleTextStyles` does not scale — so six cells were an incompressible 312dp
   * that overflowed a 320dp screen, while the glyphs grew with fontScale. At
   * fontScale >= 1.15 "Protection", "dispatched" and "Completed" character-wrapped
   * inside the cell, which is the "Prote ction act…" / "Complete d" the founder
   * photographed. Six readable labels simply do not fit across a phone; the words
   * moved to a full-width caption that cannot truncate, and each dot carries its
   * own label for screen readers.
   */
  cell: {width: 30, alignItems: 'center'},
  railLabel: {
    fontFamily: UI.fSemi, fontSize: 7.5, lineHeight: 10, letterSpacing: 0.1,
    // Slightly wider than the 30dp cell so a word has room, but no wider than
    // the cell-to-cell pitch, or adjacent labels would touch.
    color: UI.textMute, textAlign: 'center', marginTop: 4, width: 42,
  },
  dot: {
    width: 26, height: 26, borderRadius: 13, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  dotNum: {fontFamily: UI.fBold, fontSize: 11},
  caption: {
    fontFamily: UI.fSemi, fontSize: 12, lineHeight: 16, letterSpacing: 0.2,
    color: UI.text, textAlign: 'center',
  },
  conn: {flex: 1, height: 2, borderRadius: 1},
}));
