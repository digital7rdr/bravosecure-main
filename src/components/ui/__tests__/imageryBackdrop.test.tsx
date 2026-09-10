/**
 * ImageryBackdrop pins (client beautification pass, 2026-08-25).
 *
 * The backdrop puts a photograph behind card copy. Two properties are
 * load-bearing and neither is visible in a screenshot review:
 *
 *   * CONTRAST — card text is white / dim-white on obsidian `#07090D`. The
 *     scrim's job is to hold the effective background dark enough that body
 *     copy stays above the 4.5:1 WCAG AA bar (DESIGN_REVIEW_LOOP §3.4 makes a
 *     contrast miss an automatic Major). "Make the photo pop" is exactly the
 *     change that quietly breaks it, so the alpha floors are asserted here.
 *   * DECORATIVE — the photo carries no information the card's own
 *     accessibilityLabel does not, so it must be skipped by screen readers and
 *     must never swallow a touch meant for the card.
 */
import React from 'react';
import {render} from '@testing-library/react-native';
import ImageryBackdrop, {SCRIM_TEXT_ALPHA, SCRIM_TEXT_STOPS, type ImageryVariant} from '../ImageryBackdrop';

jest.mock('expo-linear-gradient', () => {
  const {View} = require('react-native');
  return {LinearGradient: (props: Record<string, unknown>) => <View testID="scrim" {...props} />};
});

const SOURCE = {uri: 'test://photo.jpg'};
/**
 * Variants that carry COPY over the photo, and therefore owe a contrast floor.
 *
 * `art` and `band` are deliberately absent for opposite reasons: `art` keeps a
 * 0.85 floor but only over its left copy field, and `band` has no copy over it
 * at all. `band`'s exemption is not taken on trust — the call-site pin below is
 * what makes it true, and `ALL_VARIANTS` still exercises both here.
 */
const VARIANTS: ImageryVariant[] = ['hero', 'card', 'tile'];
/** Every variant, including `art` — B-703 was found on `art` in production. */
const ALL_VARIANTS: ImageryVariant[] = ['hero', 'card', 'tile', 'art', 'band'];

/** Pull the alpha out of an `rgba(r,g,b,a)` string. */
function alphaOf(color: string): number {
  const m = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/.exec(color);
  if (!m) {throw new Error(`not an rgba() colour: ${color}`);}
  return Number(m[1]);
}

describe('ImageryBackdrop', () => {
  it.each(VARIANTS)('%s — is decorative and untouchable', variant => {
    const {UNSAFE_root} = render(
      <ImageryBackdrop source={SOURCE} variant={variant} radius={16} />,
    );
    const wrapper = UNSAFE_root.findByProps({importantForAccessibility: 'no-hide-descendants'});
    expect(wrapper.props.accessibilityElementsHidden).toBe(true);
    expect(wrapper.props.pointerEvents).toBe('none');
  });

  it.each(VARIANTS)('%s — scrim holds the documented alpha floor over the text zone', variant => {
    // includeHiddenElements: the wrapper is deliberately hidden from the
    // accessibility tree, and RNTL honours that in its default queries.
    const {UNSAFE_root} = render(<ImageryBackdrop source={SOURCE} variant={variant} />);
    const scrim = UNSAFE_root.findByProps({testID: 'scrim'});
    const colors = scrim.props.colors as string[];
    const locations = scrim.props.locations as number[];

    // Every stop is positioned. An RN Android gradient stop WITHOUT a location
    // takes the `else ->` branch in LinearGradient.kt and logs
    // "Unsupported type for radius property: Null" once per stop per commit.
    expect(locations).toHaveLength(colors.length);
    expect(locations.every(n => typeof n === 'number')).toBe(true);

    // Only the stops that sit under COPY have to clear the floor — a variant
    // may deliberately open up where no text lands. The pairing of direction
    // and textStops is the actual invariant: point the light end at the text
    // and this goes red.
    const floor = SCRIM_TEXT_ALPHA[variant];
    for (const i of SCRIM_TEXT_STOPS[variant]) {
      expect(alphaOf(colors[i])).toBeGreaterThanOrEqual(floor);
    }
  });

  it('never lets a variant drop below the AA-safe floor', () => {
    // 0.78 is the measured floor: against a worst-case BRIGHT source pixel it
    // keeps the dimmest token this app puts on imagery (`textMute`) at the
    // same contrast it already has on flat #07090D. Below that the photo makes
    // an already-marginal token worse. Lower it only with new numbers.
    for (const v of VARIANTS) {
      expect(SCRIM_TEXT_ALPHA[v]).toBeGreaterThanOrEqual(0.78);
    }
  });

  /**
   * The `band` variant (founder 2026-08-31: "maximum brightness, because
   * there's no writing over it").
   *
   * It is the ONLY variant with no alpha floor, so its safety is entirely the
   * claim that no copy sits over it. These pin that claim from both ends: the
   * recipe really is unscrimmed at the top, and the set of screens allowed to
   * use it is fixed — a second consumer has to come here and state that its
   * photo is text-free, instead of quietly inheriting an exemption.
   */
  describe('band — full-brightness photo with no copy over it', () => {
    it('is genuinely unscrimmed where the image reads, and full opacity', () => {
      const {UNSAFE_root, UNSAFE_getAllByType} = render(<ImageryBackdrop source={SOURCE} variant="band" />);
      const scrim = UNSAFE_root.findByProps({testID: 'scrim'});
      const colors = scrim.props.colors as string[];
      const locations = scrim.props.locations as number[];

      // Clear across the top — this is the whole point of the variant.
      expect(alphaOf(colors[0])).toBe(0);
      expect(alphaOf(colors[1])).toBe(0);
      // …and the image itself is not dimmed at all.
      const {Image} = require('react-native');
      const flat = [UNSAFE_getAllByType(Image)[0].props.style].flat(2).filter(Boolean) as Array<{opacity?: number}>;
      expect(flat.reduce<number | undefined>((a, s) => s?.opacity ?? a, undefined)).toBe(1);

      // The tail is a BLEND into the card body, not a scrim: it may not begin
      // before the bottom third, or it starts eating the photograph again.
      expect(locations[1]).toBeGreaterThanOrEqual(0.6);
      expect(alphaOf(colors[2])).toBeGreaterThan(0.8);
    });

    it('declares no text zone at all', () => {
      // If someone gives `band` a textStop they have decided copy DOES sit on
      // it, and the floor loop above must start covering it.
      expect(SCRIM_TEXT_STOPS.band).toHaveLength(0);
      expect(SCRIM_TEXT_ALPHA.band).toBe(0);
    });

    it('is used ONLY where the photo has no copy over it', () => {
      // Source scan: the exemption is per-SCREEN, and nothing in the component
      // can tell whether a caller put a label on top of the band.
      const {readFileSync, readdirSync, statSync} = require('node:fs');
      const {join} = require('node:path');
      const ALLOWED = ['src/screens/auth/ProductGateScreen.tsx'];

      const hits: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) {
            if (entry !== '__tests__' && entry !== 'node_modules') {walk(full);}
          } else if (/\.tsx$/.test(entry)) {
            // Comments stripped: this file's own prose names the variant.
            const code = readFileSync(full, 'utf8')
              .replace(/\/\*[\s\S]*?\*\//g, ' ')
              .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1');
            if (/variant=["'{]?["']?band["']?/.test(code)) {
              hits.push(full.replace(/\\/g, '/').replace(/.*\/(src\/)/, '$1'));
            }
          }
        }
      };
      walk(join(process.cwd(), 'src'));
      expect(hits.sort()).toEqual(ALLOWED.sort());
    });
  });

  it('dim only ever darkens — it can never brighten a busy source', () => {
    const {UNSAFE_getAllByType} = render(
      <ImageryBackdrop source={SOURCE} variant="card" dim={0.3} />,
    );
    const {Image} = require('react-native');
    const img = UNSAFE_getAllByType(Image)[0];
    const flat = [img.props.style].flat(2).filter(Boolean) as Array<{opacity?: number}>;
    const opacity = flat.reduce<number | undefined>((a, sObj) => sObj?.opacity ?? a, undefined);
    expect(opacity).toBeLessThan(0.85);
    expect(opacity).toBeGreaterThanOrEqual(0);
  });

  // B-703 — `StyleSheet.absoluteFill` ALONE does not size an Image under the
  // New Architecture. Position + insets without dimensions leaves the Image at
  // its INTRINSIC size, anchored top-left, so `resizeMode` never receives a box
  // to cover and the card renders a 1:1-dp corner crop of the art instead of
  // the photo. Measured on a Pixel 6a (density 2.625): a 60x45 test asset drew
  // at exactly 60x45 dp in the card's top-left corner, and a 720px asset showed
  // only its left ~24%. The sibling LinearGradient — same absoluteFill, but a
  // View — spanned the card correctly, which is what isolated it to Image.
  // The explicit 100%/100% is load-bearing: do NOT fold it back into
  // absoluteFill on the grounds that it looks redundant.
  it.each(ALL_VARIANTS)('%s — the photo is given the card box explicitly (B-703)', variant => {
    const {UNSAFE_getAllByType} = render(<ImageryBackdrop source={SOURCE} variant={variant} />);
    const {Image} = require('react-native');
    const img = UNSAFE_getAllByType(Image)[0];
    const flat = [img.props.style].flat(2).filter(Boolean) as Array<Record<string, unknown>>;
    const pick = (k: string) => flat.reduce<unknown>((acc, sObj) => sObj?.[k] ?? acc, undefined);
    expect(pick('width')).toBe('100%');
    expect(pick('height')).toBe('100%');
    // A box with no scaling rule would letterbox or stretch instead.
    expect(typeof img.props.resizeMode).toBe('string');
  });
});
