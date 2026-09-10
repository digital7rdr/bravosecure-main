/**
 * Protection-session location streamer (spec §5). A module singleton so the
 * GPS watch + retry queue survive screen re-renders and only stop on session
 * end. Extracted from the useVbgLocation / vbgTelemetry pattern rather than a
 * fourth hand-rolled copy.
 *
 * Contract:
 *   - watchPosition (~10s / 25m) enqueues the caller's OWN fixes;
 *   - a flush timer batches them to POST /protection/sessions/:id/locations —
 *     batching IS the offline catch-up (edge E): a failed flush keeps the queue
 *     and retries next tick, so a tunnel/lift gap heals itself on reconnect;
 *   - the backend's first accepted fix flips REQUESTED→ACTIVE; we surface that
 *     server status so the screen renders "Protection Active" only on the
 *     backend's word, never optimism (edge N);
 *   - coordinates are NEVER logged (§9 — treat lat/lng like key material).
 *
 * v1 is foreground-app streaming (founder decision §13.1): when the app is not
 * foregrounded the OS suspends the watch and the CPO/Ops staleness UI tells the
 * truth. An Android location-FGS is a deliberate fast-follow, not a drive-by.
 */
import Geolocation from 'react-native-geolocation-service';
import {protectionApi, type ProtectionFix, type ProtectionSessionStatus} from '@services/api';

export interface StreamStatus {
  streaming: boolean;
  queued: number;
  /** Epoch ms of the last SUCCESSFUL flush, or null. */
  lastSentAt: number | null;
  /** True when the most recent flush failed (connection lost — retrying). */
  lastError: boolean;
  /** Latest server-confirmed session status (drives the "Starting…"→Active flip). */
  serverStatus: ProtectionSessionStatus | null;
}

const FLUSH_INTERVAL_MS = 10_000;
const MAX_QUEUE = 500;               // matches the server ArrayMaxSize
const WATCH_DISTANCE_M = 25;

class ProtectionLocationService {
  private sessionId: string | null = null;
  private watchId: number | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private queue: ProtectionFix[] = [];
  private inFlight = false;
  private status: StreamStatus = {
    streaming: false, queued: 0, lastSentAt: null, lastError: false, serverStatus: null,
  };
  private listeners = new Set<(s: StreamStatus) => void>();

  start(sessionId: string): void {
    if (this.sessionId === sessionId && this.status.streaming) {return;}
    this.stop(); // clean any previous session before switching
    this.sessionId = sessionId;
    this.queue = [];
    this.setStatus({streaming: true, queued: 0, lastSentAt: null, lastError: false, serverStatus: null});

    this.watchId = Geolocation.watchPosition(
      pos => this.enqueue({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy_m: typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : undefined,
        recorded_at: new Date(pos.timestamp || Date.now()).toISOString(),
      }),
      // A watch error does not stop the session — the truthful-staleness UI on
      // the CPO/Ops side is the designed behavior while no fix flows (edge F).
      () => { /* swallow — never log coordinates or GPS errors with location */ },
      {enableHighAccuracy: true, distanceFilter: WATCH_DISTANCE_M, interval: FLUSH_INTERVAL_MS, fastestInterval: 5_000},
    );

    this.flushTimer = setInterval(() => { void this.flush(); }, FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.watchId !== null) { Geolocation.clearWatch(this.watchId); this.watchId = null; }
    if (this.flushTimer !== null) { clearInterval(this.flushTimer); this.flushTimer = null; }
    this.sessionId = null;
    this.queue = [];
    this.inFlight = false;
    this.setStatus({streaming: false, queued: 0, lastSentAt: this.status.lastSentAt, lastError: false, serverStatus: this.status.serverStatus});
  }

  subscribe(cb: (s: StreamStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => { this.listeners.delete(cb); };
  }

  getStatus(): StreamStatus { return this.status; }

  private enqueue(fix: ProtectionFix): void {
    if (!this.sessionId) {return;}
    this.queue.push(fix);
    // Bound the queue — on a very long outage keep the NEWEST fixes (the map
    // trail cares about recency, not an hour-old backlog).
    if (this.queue.length > MAX_QUEUE) {this.queue = this.queue.slice(-MAX_QUEUE);}
    this.setStatus({...this.status, queued: this.queue.length});
  }

  private async flush(): Promise<void> {
    if (this.inFlight || !this.sessionId || this.queue.length === 0) {return;}
    this.inFlight = true;
    const sessionId = this.sessionId;
    const batch = this.queue.slice(0, MAX_QUEUE);
    try {
      const {data} = await protectionApi.sendLocations(sessionId, batch);
      // Success — drop exactly what we sent (new fixes may have arrived since).
      if (this.sessionId === sessionId) {
        this.queue = this.queue.slice(batch.length);
        this.setStatus({
          ...this.status,
          queued: this.queue.length,
          lastSentAt: Date.now(),
          lastError: false,
          serverStatus: data.status,
        });
      }
    } catch {
      // Keep the queue and retry next tick (edge E). Never log the payload.
      if (this.sessionId === sessionId) {
        this.setStatus({...this.status, lastError: true});
      }
    } finally {
      this.inFlight = false;
    }
  }

  private setStatus(next: StreamStatus): void {
    this.status = next;
    for (const cb of this.listeners) {cb(next);}
  }
}

export const protectionLocationService = new ProtectionLocationService();
