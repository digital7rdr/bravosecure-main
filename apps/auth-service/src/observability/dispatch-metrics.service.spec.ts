import {DispatchMetricsService} from './dispatch-metrics.service';

describe('DispatchMetricsService (Step 26)', () => {
  let m: DispatchMetricsService;
  beforeEach(() => { m = new DispatchMetricsService(); });

  it('counts with inc (default +1, custom by) and slices by labels', () => {
    m.inc('dispatch_no_provider_total', {region: 'AE'});
    m.inc('dispatch_no_provider_total', {region: 'AE'});
    m.inc('dispatch_no_provider_total', {region: 'SA'}, 3);
    const s = m.snapshot();
    expect(s.counters['dispatch_no_provider_total{region=AE}']).toBe(2);
    expect(s.counters['dispatch_no_provider_total{region=SA}']).toBe(3);
  });

  it('label order does not matter (stable series key)', () => {
    m.inc('x', {a: '1', b: '2'});
    m.inc('x', {b: '2', a: '1'});
    expect(m.snapshot().counters['x{a=1,b=2}']).toBe(2);
  });

  it('gauges set + read back; histograms track count/sum/min/max', () => {
    m.setGauge('dispatch_watchdog_last_run_ts', 1000, {sweep: 'offer'});
    expect(m.getGauge('dispatch_watchdog_last_run_ts', {sweep: 'offer'})).toBe(1000);
    m.observe('dispatch_rank_query_ms', 10, {region: 'AE'});
    m.observe('dispatch_rank_query_ms', 30, {region: 'AE'});
    const h = m.snapshot().histos['dispatch_rank_query_ms{region=AE}'];
    expect(h).toEqual({count: 2, sum: 40, min: 10, max: 30});
  });

  it('serializes Prometheus text (counters, gauges, histogram _count/_sum/_max)', () => {
    m.inc('dispatch_no_provider_total', {region: 'AE'});
    m.setGauge('g', 5);
    m.observe('dispatch_rank_query_ms', 12, {region: 'AE'});
    const text = m.prometheus();
    expect(text).toMatch(/dispatch_no_provider_total\{region="AE"\} 1/);
    expect(text).toMatch(/^g 5$/m);
    expect(text).toMatch(/dispatch_rank_query_ms_count\{region="AE"\} 1/);
    expect(text).toMatch(/dispatch_rank_query_ms_sum\{region="AE"\} 12/);
  });
});
