import {Injectable} from '@nestjs/common';

/**
 * In-memory dispatch metric registry (BUILD_RUNBOOK Step 26). No new dependency — a tiny
 * counter / gauge / histogram store that serializes to Prometheus text on GET /metrics.
 * The dispatch service, the watchdog sweeps, the SLO evaluator, and the Step-28
 * reconciliation sweep all write here; /ready and the SLO evaluator read the gauges.
 *
 * Labels are flattened into the series key so a metric can be sliced by region/sweep.
 * This is process-local (per pod) — fine for the metric set the spec defines (rates,
 * latencies, liveness gauges); a Prometheus scrape aggregates across pods.
 */
type Labels = Record<string, string | number>;

interface Histo {
  count: number;
  sum: number;
  min: number;
  max: number;
}

@Injectable()
export class DispatchMetricsService {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histos = new Map<string, Histo>();
  // series key → {name, labels} so we can re-expand for Prometheus output.
  private readonly meta = new Map<string, {name: string; labels: Labels}>();

  /** Stable series key: name + sorted label pairs (so {a,b} === {b,a}). */
  private key(name: string, labels?: Labels): string {
    if (!labels || Object.keys(labels).length === 0) {
      this.meta.set(name, {name, labels: {}});
      return name;
    }
    const parts = Object.keys(labels).sort().map(k => `${k}=${labels[k]}`);
    const k = `${name}{${parts.join(',')}}`;
    this.meta.set(k, {name, labels});
    return k;
  }

  inc(name: string, labels?: Labels, by = 1): void {
    const k = this.key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(this.key(name, labels), value);
  }

  /** Read a gauge back (used by /ready + the SLO evaluator). */
  getGauge(name: string, labels?: Labels): number | undefined {
    return this.gauges.get(this.key(name, labels));
  }

  observe(name: string, value: number, labels?: Labels): void {
    const k = this.key(name, labels);
    const h = this.histos.get(k);
    if (!h) {
      this.histos.set(k, {count: 1, sum: value, min: value, max: value});
    } else {
      h.count += 1;
      h.sum += value;
      if (value < h.min) {h.min = value;}
      if (value > h.max) {h.max = value;}
    }
  }

  /** Structured snapshot (used by tests + the SLO evaluator). */
  snapshot(): {counters: Record<string, number>; gauges: Record<string, number>; histos: Record<string, Histo>} {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histos: Object.fromEntries(this.histos),
    };
  }

  /** Prometheus text exposition (GET /metrics). */
  prometheus(): string {
    const lines: string[] = [];
    const series = (k: string): string => {
      const m = this.meta.get(k);
      if (!m || Object.keys(m.labels).length === 0) {return m?.name ?? k;}
      const parts = Object.keys(m.labels).sort().map(l => `${l}="${String(m.labels[l]).replace(/"/g, '')}"`);
      return `${m.name}{${parts.join(',')}}`;
    };
    for (const [k, v] of this.counters) {lines.push(`${series(k)} ${v}`);}
    for (const [k, v] of this.gauges) {lines.push(`${series(k)} ${v}`);}
    for (const [k, h] of this.histos) {
      const m = this.meta.get(k);
      const base = m?.name ?? k;
      const lbl = m && Object.keys(m.labels).length > 0
        ? `{${Object.keys(m.labels).sort().map(l => `${l}="${String(m!.labels[l]).replace(/"/g, '')}"`).join(',')}}`
        : '';
      lines.push(`${base}_count${lbl} ${h.count}`);
      lines.push(`${base}_sum${lbl} ${h.sum}`);
      lines.push(`${base}_max${lbl} ${h.max}`);
    }
    return lines.join('\n') + '\n';
  }
}
