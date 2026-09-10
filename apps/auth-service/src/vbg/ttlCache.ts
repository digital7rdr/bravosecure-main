/**
 * Tiny bounded TTL cache for the VBG intel sources (GDELT / NewsData /
 * Google News / geocode). GeoRisk lets users query arbitrary places, so an
 * unbounded Map grows for the life of the process — this caps entries and
 * sweeps expired ones on write.
 */
export class TtlCache<T> {
  private readonly map = new Map<string, {at: number; value: T}>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) {return undefined;}
    if (Date.now() - hit.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.map.size >= this.maxEntries) {
      const now = Date.now();
      for (const [k, e] of this.map) {
        if (now - e.at >= this.ttlMs) {this.map.delete(k);}
      }
      // Still full after the sweep — evict oldest-inserted until under cap.
      while (this.map.size >= this.maxEntries) {
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) {break;}
        this.map.delete(oldest);
      }
    }
    this.map.set(key, {at: Date.now(), value});
  }

  get size(): number { return this.map.size; }
}
