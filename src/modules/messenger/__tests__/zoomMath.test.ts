import {
  clampScale,
  clampTranslation,
  containRect,
  DOUBLE_TAP_SCALE,
  MAX_SCALE,
  MIN_SCALE,
} from '../ui/zoomMath';

describe('clampScale', () => {
  it('bounds to [MIN, MAX] and swallows junk', () => {
    expect(clampScale(0.4)).toBe(MIN_SCALE);
    expect(clampScale(2.2)).toBe(2.2);
    expect(clampScale(9)).toBe(MAX_SCALE);
    expect(clampScale(NaN)).toBe(MIN_SCALE);
    expect(clampScale(-3)).toBe(MIN_SCALE);
  });

  it('double-tap target sits inside the clamp range', () => {
    expect(clampScale(DOUBLE_TAP_SCALE)).toBe(DOUBLE_TAP_SCALE);
  });
});

describe('containRect', () => {
  it('letterboxes a wide image by width', () => {
    expect(containRect(400, 800, 2000, 1000)).toEqual({width: 400, height: 200});
  });
  it('pillarboxes a tall image by height', () => {
    expect(containRect(400, 800, 500, 2000)).toEqual({width: 200, height: 800});
  });
  it('degrades to the viewport when dimensions are unknown', () => {
    expect(containRect(400, 800, 0, 0)).toEqual({width: 400, height: 800});
  });
});

describe('clampTranslation', () => {
  const box = {viewW: 400, viewH: 800, contentW: 400, contentH: 200};

  it('pins to centre when the scaled content fits the axis', () => {
    // 200*2 = 400 tall < 800 viewport — vertical pan snaps home.
    const r = clampTranslation({...box, scale: 2, tx: 500, ty: 300});
    expect(r.ty).toBe(0);
    // 400*2 = 800 wide > 400 viewport — overflow 400, max pull 200.
    expect(r.tx).toBe(200);
  });

  it('allows symmetric pull up to half the overflow', () => {
    const r = clampTranslation({...box, scale: 3, tx: -1000, ty: 0});
    // overflow = 400*3 - 400 = 800 → max 400.
    expect(r.tx).toBe(-400);
  });

  it('returns identity inside bounds', () => {
    const r = clampTranslation({...box, scale: 3, tx: 120, ty: 0});
    expect(r).toEqual({tx: 120, ty: 0});
  });

  it('swallows NaN drags', () => {
    const r = clampTranslation({...box, scale: 2, tx: NaN, ty: NaN});
    expect(r).toEqual({tx: 0, ty: 0});
  });
});
