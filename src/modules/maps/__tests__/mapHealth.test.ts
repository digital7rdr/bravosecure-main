import {mapHealthReducer, INITIAL_MAP_HEALTH, type MapHealthState} from '../useMapReload';

const reduce = (s: MapHealthState, e: Parameters<typeof mapHealthReducer>[1], max = 1) =>
  mapHealthReducer(s, e, max);

describe('mapHealthReducer (B-77) — WebView map recovery state machine', () => {
  it('starts loading and reaches ready on the ready signal', () => {
    const s = reduce(INITIAL_MAP_HEALTH, {t: 'ready'});
    expect(s.status).toBe('ready');
    expect(s.reloadKey).toBe(0);
  });

  it('first fail auto-remounts (bumps reloadKey, stays loading) within the retry budget', () => {
    const s = reduce(INITIAL_MAP_HEALTH, {t: 'fail'}, 1);
    expect(s.status).toBe('loading');
    expect(s.reloadKey).toBe(1);
    expect(s.autoRetries).toBe(1);
  });

  it('exhausting the retry budget surfaces the failed state', () => {
    const s1 = reduce(INITIAL_MAP_HEALTH, {t: 'fail'}, 1); // auto-remount
    const s2 = reduce(s1, {t: 'fail'}, 1);                 // budget spent → failed
    expect(s2.status).toBe('failed');
    expect(s2.reloadKey).toBe(1); // no further remount
  });

  it('a manual retry from failed starts a fresh attempt with a full budget', () => {
    const failed: MapHealthState = {status: 'failed', reloadKey: 1, autoRetries: 1};
    const s = reduce(failed, {t: 'retry'}, 1);
    expect(s.status).toBe('loading');
    expect(s.reloadKey).toBe(2);
    expect(s.autoRetries).toBe(0);
  });

  it('a ready after an auto-remount clears the retry budget (so a later manual retry starts fresh)', () => {
    const afterOneFail = reduce(INITIAL_MAP_HEALTH, {t: 'fail'}, 1); // autoRetries=1, loading
    const ready = reduce(afterOneFail, {t: 'ready'}, 1);
    expect(ready.status).toBe('ready');
    expect(ready.autoRetries).toBe(0);
  });

  it('ignores a late fail once the map is ready (recoverable post-load tile error)', () => {
    const ready: MapHealthState = {status: 'ready', reloadKey: 0, autoRetries: 0};
    expect(reduce(ready, {t: 'fail'})).toBe(ready);
  });

  it('with zero auto-retries a single fail goes straight to failed', () => {
    const s = reduce(INITIAL_MAP_HEALTH, {t: 'fail'}, 0);
    expect(s.status).toBe('failed');
    expect(s.reloadKey).toBe(0);
  });
});
