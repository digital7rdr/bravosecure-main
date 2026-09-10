import {MAX_PICKED_ASSETS, normalizePickedAssets, withBatchCaption, type PickedAsset} from '../ui/pickedAssets';

describe('normalizePickedAssets', () => {
  it('maps picker fields and classifies image vs video', () => {
    const out = normalizePickedAssets([
      {uri: 'file:///a.jpg', type: 'image/jpeg', fileName: 'a.jpg', width: 100, height: 50},
      {uri: 'file:///b.mp4', type: 'video/mp4', duration: 12.4},
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      uri: 'file:///a.jpg', mime: 'image/jpeg', kind: 'image',
      meta: {name: 'a.jpg', width: 100, height: 50, durationMs: undefined},
    });
    expect(out[1].kind).toBe('video');
    expect(out[1].meta.durationMs).toBe(12400);
  });

  it('drops uri-less assets and defaults mime to jpeg', () => {
    const out = normalizePickedAssets([
      {uri: undefined, type: 'image/png'},
      {uri: 'file:///c'},
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].mime).toBe('image/jpeg');
    expect(out[0].kind).toBe('image');
  });

  it('caps at MAX_PICKED_ASSETS', () => {
    const many = Array.from({length: MAX_PICKED_ASSETS + 5}, (_, i) => ({uri: `file:///p${i}.jpg`}));
    expect(normalizePickedAssets(many)).toHaveLength(MAX_PICKED_ASSETS);
  });

  it('handles empty/undefined input', () => {
    expect(normalizePickedAssets(undefined)).toEqual([]);
    expect(normalizePickedAssets([])).toEqual([]);
  });
});

/**
 * B-707 — the founder could not put a message on a photo ("just like WhatsApp
 * we can attach image and can attach msg also"). The caption is typed in
 * `MediaPreviewTray` and stamped onto the batch here.
 */
describe('withBatchCaption', () => {
  const A = (uri: string): PickedAsset => ({uri, mime: 'image/jpeg', kind: 'image', meta: {}});

  it('lands on the FIRST item only — one caption per batch, WhatsApp-style', () => {
    const out = withBatchCaption([A('a'), A('b'), A('c')], 'at the pool');
    expect(out[0].caption).toBe('at the pool');
    expect(out[1].caption).toBeUndefined();
    expect(out[2].caption).toBeUndefined();
  });

  it('trims, and drops a blank caption entirely', () => {
    expect(withBatchCaption([A('a')], '  hi  ')[0].caption).toBe('hi');
    // Not '' — an empty string in `content` would make `hasCaption` false but
    // still travel as a body; undefined keeps the untouched field a no-op.
    expect(withBatchCaption([A('a')], '   ')[0].caption).toBeUndefined();
    expect(withBatchCaption([A('a')], '')[0].caption).toBeUndefined();
  });

  it('never mutates the input batch', () => {
    const input = [A('a'), A('b')];
    const out = withBatchCaption(input, 'hello');
    expect(input[0].caption).toBeUndefined();
    expect(out).not.toBe(input);
  });

  it('is a no-op on an empty batch', () => {
    expect(withBatchCaption([], 'hello')).toEqual([]);
  });
});
