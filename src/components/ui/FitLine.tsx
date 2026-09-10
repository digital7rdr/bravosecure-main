/**
 * FitLine — deterministic single-line shrink-to-fit.
 *
 * Replaces `adjustsFontSizeToFit` + `minimumFontScale`, which are the source
 * of the "my phone is fine, that phone cuts" class (founder, 2026-08-26 —
 * second-device screenshot): under the New Architecture `minimumFontScale` is
 * IGNORED on both platforms (facebook/react-native#50248) and
 * `adjustsFontSizeToFit` on Android/Fabric collapses toward the minimum
 * (#32258) or does not resize at all (#43104). `newArchEnabled=true` here, so
 * every use of that pair renders differently per device. B-660 replaced it on
 * the two big headers with measured-window bands; this component finishes the
 * class for every remaining single-line caption/label, and the
 * headerFitContract scan now bans the pair app-wide.
 *
 * Mechanism: a hidden, unconstrained measuring twin reports the line's
 * NATURAL width (the visible line cannot self-report it — `numberOfLines={1}`
 * truncates its own onTextLayout width to the slot). The visible line then
 * scales by exactly availableWidth / naturalWidth, floored, once.
 * letterSpacing scales with the glyphs, or the tracking eats the saving
 * (the B-657 lesson). Deterministic: same device, same numbers, every render.
 *
 * Below `floorScale` the line ellipsises instead — unreadably small is worse
 * than truncation.
 */
import React, {useState} from 'react';
import {View, Text, StyleSheet, type StyleProp, type TextStyle} from 'react-native';

interface Props {
  text: string;
  style?: StyleProp<TextStyle>;
  /** Smallest fraction of the designed size before ellipsising. */
  floorScale?: number;
  /** Accessibility font-scale cap — twin and visible line share it, so the
   *  measurement includes the user's font setting. */
  maxFontSizeMultiplier?: number;
}

export default function FitLine({
  text,
  style,
  floorScale = 0.6,
  maxFontSizeMultiplier = 1.2,
}: Props) {
  const [availW, setAvailW] = useState(0);
  const [naturalW, setNaturalW] = useState(0);

  const flat = StyleSheet.flatten(style) ?? {};
  const base = typeof flat.fontSize === 'number' ? flat.fontSize : 14;
  const baseLs = typeof flat.letterSpacing === 'number' ? flat.letterSpacing : undefined;

  const needsFit = availW > 0 && naturalW > availW;
  // Math.floor at 2dp: stable across re-renders, never rounds UP into a cut.
  const scale = needsFit ? Math.max(floorScale, Math.floor((availW / naturalW) * 100) / 100) : 1;

  return (
    <View style={s.slot} onLayout={e => setAvailW(e.nativeEvent.layout.width)}>
      {/* Measuring twin — always at the DESIGNED size, never the corrected one. */}
      <Text
        style={[style, s.twin]}
        numberOfLines={1}
        maxFontSizeMultiplier={maxFontSizeMultiplier}
        onTextLayout={e => {
          const w = e.nativeEvent.lines[0]?.width ?? 0;
          if (w > 0 && w !== naturalW) {setNaturalW(w);}
        }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants">
        {text}
      </Text>
      <Text
        style={[
          style,
          scale < 1 && {
            fontSize: base * scale,
            letterSpacing: baseLs !== undefined ? baseLs * scale : undefined,
          },
        ]}
        numberOfLines={1}
        maxFontSizeMultiplier={maxFontSizeMultiplier}>
        {text}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  slot: {alignSelf: 'stretch', flexShrink: 1, minWidth: 0},
  // Wide absolute box so the twin lays out UNconstrained; invisible and out of
  // the accessibility tree. Margins from the caller style are neutralised so
  // the twin cannot grow the slot.
  twin: {position: 'absolute', left: 0, top: 0, width: 4000, opacity: 0, margin: 0, marginTop: 0},
});
