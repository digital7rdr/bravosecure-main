/**
 * Unit tests for the responsive scaling primitives.
 *
 * scaling.ts reads Dimensions.get('window') at MODULE LOAD, so each device
 * size is exercised by mocking react-native's Dimensions and re-requiring
 * the module under jest.isolateModules / resetModules.
 */

import type * as ScalingModule from '../scaling';

type Scaling = typeof ScalingModule;

function loadAt(width: number, height: number): Scaling {
  let mod: Scaling;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({
      Dimensions: {get: () => ({width, height})},
      PixelRatio: {roundToNearestPixel: (n: number) => n},
      useWindowDimensions: () => ({width, height}),
    }));
    mod = require('../scaling');
  });
  // @ts-expect-error assigned inside isolateModules callback
  return mod;
}

const BASE_W = 375;
const BASE_H = 812;

describe('scale / verticalScale / moderateScale', () => {
  it('is the identity at the 375×812 reference device', () => {
    const s = loadAt(BASE_W, BASE_H);
    expect(s.scale(16)).toBe(16);
    expect(s.verticalScale(20)).toBe(20);
    expect(s.scaleFont(16)).toBe(16);
  });

  it('moderateScale(x, 0) returns x unchanged on any device', () => {
    const s = loadAt(320, 700);
    expect(s.moderateScale(16, 0)).toBe(16);
    expect(s.moderateScale(40, 0)).toBe(40);
  });

  it('moderateScale is damped: between identity and full linear on large screens', () => {
    const s = loadAt(768, 1024);
    const linear = s.scale(20); // full ratio
    const moderate = s.moderateScale(20); // factor 0.5
    expect(moderate).toBeGreaterThan(20);
    expect(moderate).toBeLessThan(linear);
  });

  it('scales down on a small phone', () => {
    const s = loadAt(320, 568);
    expect(s.scale(20)).toBeLessThan(20);
  });
});

describe('scaleFont clamps', () => {
  it('never grows beyond 1.20× of design size on a tablet', () => {
    const s = loadAt(768, 1024);
    expect(s.scaleFont(32)).toBeLessThanOrEqual(Math.round(32 * 1.2));
  });

  it('never shrinks below 0.85× of design size on a tiny phone', () => {
    const s = loadAt(320, 568);
    expect(s.scaleFont(11)).toBeGreaterThanOrEqual(Math.round(11 * 0.85));
  });
});

describe('breakpoints', () => {
  it('flips isSmallPhone below 350', () => {
    expect(loadAt(320, 568).isSmallPhone).toBe(true);
    expect(loadAt(375, 812).isSmallPhone).toBe(false);
  });

  it('flips isLargePhone at 414', () => {
    expect(loadAt(390, 844).isLargePhone).toBe(false);
    expect(loadAt(414, 896).isLargePhone).toBe(true);
  });

  it('flips isTablet at 600', () => {
    expect(loadAt(414, 896).isTablet).toBe(false);
    expect(loadAt(768, 1024).isTablet).toBe(true);
  });

  it('maxContentWidth constrains on tablet, equals width on phone', () => {
    expect(loadAt(768, 1024).maxContentWidth).toBe(560);
    expect(loadAt(375, 812).maxContentWidth).toBe(375);
  });
});

describe('scaleTextStyles', () => {
  it('scales text keys and leaves non-text props untouched', () => {
    const s = loadAt(768, 1024);
    const out = s.scaleTextStyles({
      title: {fontSize: 24, lineHeight: 32, color: '#fff', width: 100},
      box: {width: 50, height: 50},
    });
    // fontSize grows (but clamped) on a tablet
    expect(out.title.fontSize).toBeGreaterThan(24);
    expect(out.title.fontSize).toBeLessThanOrEqual(Math.round(24 * 1.2));
    // non-text props are passed through unchanged
    expect(out.title.color).toBe('#fff');
    expect(out.title.width).toBe(100);
    expect(out.box.width).toBe(50);
    expect(out.box.height).toBe(50);
  });

  it('is the identity for text at the reference device', () => {
    const s = loadAt(BASE_W, BASE_H);
    const out = s.scaleTextStyles({t: {fontSize: 15, lineHeight: 22}});
    expect(out.t.fontSize).toBe(15);
    expect(out.t.lineHeight).toBe(22);
  });
});

describe('useContentWidth (reactive, foldable-aware)', () => {
  it('is full-bleed on a phone — no cap, not large', () => {
    const s = loadAt(390, 844);
    const r = s.useContentWidth(560);
    expect(r.isLargeScreen).toBe(false);
    expect(r.contentMaxWidth).toBe(390);
  });

  it('caps + flags large on an unfolded/tablet width', () => {
    const s = loadAt(840, 1000);
    const r = s.useContentWidth(560);
    expect(r.isLargeScreen).toBe(true);
    expect(r.contentMaxWidth).toBe(560);
  });

  it('flips large exactly at the 600 breakpoint (matches isTablet)', () => {
    expect(loadAt(599, 900).useContentWidth().isLargeScreen).toBe(false);
    expect(loadAt(600, 900).useContentWidth().isLargeScreen).toBe(true);
  });

  it('never caps above the live width (narrow large screen keeps full width)', () => {
    const r = loadAt(620, 900).useContentWidth(720);
    expect(r.isLargeScreen).toBe(true);
    expect(r.contentMaxWidth).toBe(620);
  });
});
