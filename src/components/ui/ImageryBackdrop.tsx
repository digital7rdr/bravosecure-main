/**
 * ImageryBackdrop — the atmospheric brand photo that sits BEHIND card content.
 *
 * The design direction (founder mocks 2026-08-01, client request 2026-08-25) is
 * photographic imagery fading into the obsidian surface, never a photo the user
 * reads content off. That distinction is the whole component:
 *
 *   1. The photo is DECORATIVE. It is hidden from screen readers and never
 *      receives touches — the card underneath keeps its own role/label.
 *   2. The scrim is NOT cosmetic. Card copy is white/dim-white on `#07090D`;
 *      dropping a photo behind it without a floor would sink contrast under the
 *      4.5:1 WCAG AA body-text bar that DESIGN_REVIEW_LOOP §3.4 treats as an
 *      automatic Major. Every variant therefore pins a MINIMUM obsidian alpha
 *      across the region where text actually sits, and `imageryBackdrop.test.ts`
 *      asserts those floors so a future "let's make it brighter" pass has to
 *      argue with a red test rather than silently ship unreadable cards.
 *
 * Perf note: this repo's lag work (CLAUDE.md, B-279/B-285) measured every jank
 * bucket as *Slow UI thread*, with the GPU idle at 3-7ms against a 16.7ms
 * budget. Extra gradient overdraw is therefore cheap here; extra VIEWS and
 * image DECODES are not. So each variant renders exactly one `Image` + one
 * `LinearGradient`, the component is memoised, and Android's cross-fade is
 * disabled (`fadeDuration={0}`) to avoid an extra commit per card.
 */
import React from 'react';
import {View, Image, StyleSheet, type ImageSourcePropType, type ViewStyle} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';

export type ImageryVariant = 'hero' | 'card' | 'tile' | 'art' | 'band';

/**
 * Obsidian scrim recipes. `colors`/`locations` are always supplied together and
 * explicitly — a gradient stop without a position takes RN Android's
 * `else ->` branch and logs `Unsupported type for radius property: Null` once
 * per stop per commit (CLAUDE.md measurement trap #2).
 *
 * `minTextAlpha` documents the floor the scrim guarantees over the text zone,
 * and is what the contrast test reads.
 */
const SCRIM: Record<ImageryVariant, {
  colors: readonly [string, string, string];
  locations: readonly [number, number, number];
  start: {x: number; y: number};
  end: {x: number; y: number};
  imageOpacity: number;
  /**
   * Founder 2026-08-27 — every variant is `cover` again. The 08-26 `contain`
   * detour existed because the first art drop was cut to mixed shapes
   * (720×350-554) that `cover` cropped the subject out of; rendered `contain`
   * they floated as letterboxed bands ("the photo is broken"). The real fix is
   * the ASSET CONTRACT, not the renderer: card art is authored at
   * **1200×900 px (4:3)** with the subject inside the central 80% and the left
   * ~40% fading to near-black — see the module-card spec in BUILD_RUNBOOK.
   * The field stays so a future variant CAN opt out deliberately.
   */
  resizeMode: 'cover' | 'contain';
  minTextAlpha: number;
  /**
   * Indices of the stops that actually sit under card COPY. A variant is
   * allowed to let the photo breathe at its far stop — but only where no text
   * lands, so the gradient's light end and the text zone must point in
   * opposite directions. Getting this backwards is how the first draft of the
   * `card` variant put its lightest stop under the title.
   */
  textStops: readonly number[];
}> = {
  // Full-bleed hero: the photo lives in the TOP third (behind the icon, where
  // no copy lands) and the ramp reaches near-solid by 72% so the headline,
  // sub-line and CTA all sit on effectively-flat obsidian.
  //
  // The ramp is steep on purpose. The hero sub-line is `textMute`
  // (rgba(180,188,204,0.45)), which is already a low-contrast token on flat
  // #07090D — so the bar here is "the photo must not make it materially
  // WORSE", not merely "looks fine on a dark photo". Against a worst-case
  // bright source pixel (headlights, city lights) a 0.66 floor put that
  // sub-line near 4.0:1; 0.78+ keeps it at the flat-card baseline.
  hero: {
    colors: ['rgba(7,9,13,0.22)', 'rgba(7,9,13,0.78)', 'rgba(7,9,13,0.95)'],
    locations: [0, 0.42, 0.72],
    start: {x: 0.5, y: 0},
    end: {x: 0.5, y: 1},
    imageOpacity: 0.9,
    resizeMode: 'cover',
    minTextAlpha: 0.78,
    textStops: [1, 2],
  },
  // Module / service card: the icon sits top-left and the title + description
  // run along the BOTTOM. So the scrim runs bottom-left (solid, under the copy)
  // to top-right (open, where the photo is free to show) — the diagonal has to
  // point AWAY from the text, not along it.
  card: {
    colors: ['rgba(7,9,13,0.96)', 'rgba(7,9,13,0.82)', 'rgba(7,9,13,0.40)'],
    locations: [0, 0.52, 1],
    start: {x: 0, y: 1},
    end: {x: 1, y: 0},
    imageOpacity: 0.95,
    resizeMode: 'cover',
    minTextAlpha: 0.82,
    textStops: [0, 1],
  },
  // Purpose-made card ART (the client's 2026-08-26 drop): images composed FOR
  // these cards — subject on the right, a deliberately BLACK left field where
  // the copy sits. Measured luminance 3-29/255, i.e. the art carries its own
  // obsidian ground, so the `card` scrim flattened it to nothing ("no design
  // applied", founder screenshot). Full opacity; the left gradient is only
  // INSURANCE over the copy zone, fading to clear where the artwork lives.
  art: {
    colors: ['rgba(7,9,13,0.85)', 'rgba(7,9,13,0.30)', 'rgba(7,9,13,0)'],
    locations: [0, 0.45, 1],
    start: {x: 0, y: 0.5},
    end: {x: 1, y: 0.5},
    imageOpacity: 1,
    resizeMode: 'cover',
    minTextAlpha: 0.85,
    textStops: [0],
  },
  // Photo BAND above a card body — the founder's 2026-08-31 note: "make these
  // images maximum brightness, because there's no writing over it."
  //
  // This is the one arrangement where the scrim's whole justification is
  // absent. Every other variant puts copy ON the photo, so its alpha floor is
  // what keeps that copy above 4.5:1. Here the photo lives in its own fixed
  // band and the title/description sit in a SIBLING view below it, on the flat
  // card surface — no text ever crosses the image, so a contrast floor over it
  // would be protecting nothing while costing the photograph.
  //
  // Hence `imageOpacity: 1` and a gradient that is fully CLEAR across the top
  // 62%. The tail is NOT dimming and must not be removed: the band has no
  // border of its own, so without it the photo ends on a hard horizontal cut
  // against the card body. It ramps only inside the bottom third, which is the
  // blend, not a scrim.
  //
  // `minTextAlpha: 0` / `textStops: []` are the honest encoding of "no copy
  // here". They are not an exemption to reuse — `imageryBackdrop.test.tsx`
  // pins the CALL SITES of this variant precisely so that putting text over a
  // band goes red instead of shipping unreadable.
  band: {
    colors: ['rgba(7,9,13,0)', 'rgba(7,9,13,0)', 'rgba(7,9,13,0.92)'],
    locations: [0, 0.62, 1],
    start: {x: 0.5, y: 0},
    end: {x: 0.5, y: 1},
    imageOpacity: 1,
    resizeMode: 'cover',
    minTextAlpha: 0,
    textStops: [],
  },
  // Small trust tile: the photo is texture only — the label is the content.
  tile: {
    colors: ['rgba(7,9,13,0.62)', 'rgba(7,9,13,0.82)', 'rgba(7,9,13,0.95)'],
    locations: [0, 0.5, 1],
    start: {x: 0.5, y: 0},
    end: {x: 0.5, y: 1},
    imageOpacity: 0.55,
    resizeMode: 'cover',
    minTextAlpha: 0.82,
    textStops: [1, 2],
  },
};

/** Exported for the contrast test — see the scrim rationale above. */
export const SCRIM_TEXT_ALPHA: Record<ImageryVariant, number> = {
  hero: SCRIM.hero.minTextAlpha,
  card: SCRIM.card.minTextAlpha,
  tile: SCRIM.tile.minTextAlpha,
  art: SCRIM.art.minTextAlpha,
  band: SCRIM.band.minTextAlpha,
};

/** Which gradient stops sit under card copy, per variant. See `textStops`. */
export const SCRIM_TEXT_STOPS: Record<ImageryVariant, readonly number[]> = {
  hero: SCRIM.hero.textStops,
  card: SCRIM.card.textStops,
  tile: SCRIM.tile.textStops,
  art: SCRIM.art.textStops,
  band: SCRIM.band.textStops,
};

interface Props {
  source: ImageSourcePropType;
  variant?: ImageryVariant;
  /** Match the parent card's borderRadius so the photo clips to the corners. */
  radius?: number;
  /** Extra dimming for a busy/bright source (e.g. a daylight portrait). 0-1. */
  dim?: number;
  style?: ViewStyle;
}

function ImageryBackdropInner({source, variant = 'card', radius = 0, dim = 0, style}: Props) {
  const cfg = SCRIM[variant];
  const opacity = Math.max(0, cfg.imageOpacity - dim);

  return (
    <View
      style={[StyleSheet.absoluteFill, {borderRadius: radius, overflow: 'hidden'}, style]}
      pointerEvents="none"
      // Decorative: the card that owns this backdrop carries the real
      // accessibilityRole/Label, so the photo must not appear in the
      // screen-reader traversal at all (DESIGN_REVIEW_LOOP §3.4).
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      <Image
        source={source}
        style={[StyleSheet.absoluteFill, {width: '100%', height: '100%', opacity}]}
        resizeMode={cfg.resizeMode}
        fadeDuration={0}
      />
      <LinearGradient
        colors={cfg.colors as unknown as string[]}
        locations={cfg.locations as unknown as number[]}
        start={cfg.start}
        end={cfg.end}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
    </View>
  );
}

export default React.memo(ImageryBackdropInner);
