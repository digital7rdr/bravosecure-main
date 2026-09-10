import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import * as os from 'node:os';
import * as mediasoup from 'mediasoup';
import type {types as MS} from 'mediasoup';

/**
 * mediasoup Worker pool.
 *
 * Each Worker is a separate C++ process that handles RTP/SRTP routing
 * for one or more Routers. The Node.js side stays free of media-plane
 * work — it only orchestrates. We pin one Worker per CPU core so that
 * a server with N cores can fan out to N parallel media pipelines
 * without contention.
 *
 * Routers are created on a Worker chosen round-robin from the pool.
 * Once placed, a Router (and the call it backs) lives on that Worker
 * until the room ends — Workers are not migrated mid-call.
 *
 * Crash recovery: when a Worker `died`s, every Router on it is gone —
 * SRTP state can't be rebuilt, so calls on that worker drop and
 * clients re-join. The pool tries to refill the empty slot with
 * exponential backoff (1s, 2s, 4s, 8s, capped at 30s) up to a
 * per-slot retry budget. Three failures in a 5-min window mark the
 * slot dead and alert — sustained worker death almost always means
 * an OOM / ulimit / cert issue that needs a human, not silent retry.
 */
@Injectable()
export class SfuWorkerPool implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SfuWorkerPool.name);
  private workers: MS.Worker[] = [];
  private nextWorker = 0;
  /**
   * Per-slot restart history. Each slot tracks the last few failure
   * timestamps so we can decide whether to retry or surrender.
   */
  private readonly restartHistory: number[][] = [];
  private shuttingDown = false;
  /** Public counter so /sfu/stats can surface restart pressure. */
  private restartTotals = 0;

  constructor(private readonly cfg: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const desired = this.cfg.get<number>('sfu.workerCount') ?? os.cpus().length;
    const logLevel = this.cfg.get<MS.WorkerLogLevel>('sfu.workerLogLevel') ?? 'warn';
    const rtcMinPort = this.cfg.get<number>('sfu.rtcMinPort') ?? 40000;
    const rtcMaxPort = this.cfg.get<number>('sfu.rtcMaxPort') ?? 49999;

    this.log.log(`bootstrapping ${desired} mediasoup Worker(s) — RTC ${rtcMinPort}-${rtcMaxPort}`);
    for (let slot = 0; slot < desired; slot++) {
      this.restartHistory[slot] = [];
      // eslint-disable-next-line no-await-in-loop
      await this.spawnSlot(slot, rtcMinPort, rtcMaxPort, logLevel);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(this.workers.map(w => {
      try { w.close(); } catch { /* ignore */ }
      return Promise.resolve();
    }));
    this.workers = [];
  }

  /**
   * Pick the next Worker round-robin and create a Router on it. The
   * router's RTP capabilities are advertised to clients via the
   * `sfu.joined` frame; clients call `Device.load(routerRtpCapabilities)`
   * before they can produce/consume.
   */
  async createRouter(): Promise<MS.Router> {
    if (this.workers.length === 0) throw new Error('sfu_pool_empty');
    const worker = this.workers[this.nextWorker % this.workers.length];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    return worker.createRouter({
      mediaCodecs: ROUTER_MEDIA_CODECS,
    });
  }

  stats(): {workers: number; nextIdx: number; restartTotals: number} {
    return {workers: this.workers.length, nextIdx: this.nextWorker, restartTotals: this.restartTotals};
  }

  /**
   * Spawn a Worker for the given slot. On Worker death, schedules a
   * restart with capped exponential backoff. Pass-through when the
   * pool is shutting down so OnModuleDestroy doesn't fight us.
   */
  private async spawnSlot(
    slot: number,
    rtcMinPort: number, rtcMaxPort: number, logLevel: MS.WorkerLogLevel,
  ): Promise<void> {
    if (this.shuttingDown) return;
    const worker = await mediasoup.createWorker({
      logLevel,
      rtcMinPort, rtcMaxPort,
    });
    worker.on('died', (err) => {
      // Calls on this Worker have already dropped — no remediation.
      this.log.error(
        `Worker ${worker.pid} (slot ${slot}) died: ${err?.message ?? 'unknown'} — calls on it have dropped`,
      );
      this.workers = this.workers.filter(w => w !== worker);
      this.scheduleRestart(slot, rtcMinPort, rtcMaxPort, logLevel);
    });
    this.workers.push(worker);
    this.log.log(`slot ${slot}: worker ${worker.pid} ready`);
  }

  private scheduleRestart(
    slot: number,
    rtcMinPort: number, rtcMaxPort: number, logLevel: MS.WorkerLogLevel,
  ): void {
    if (this.shuttingDown) return;
    const hist = this.restartHistory[slot] ?? [];
    const now = Date.now();
    // Drop entries older than 5 min so transient blips don't poison
    // the slot forever.
    const recent = hist.filter(ts => now - ts < 5 * 60_000);
    recent.push(now);
    this.restartHistory[slot] = recent;

    if (recent.length > MAX_RESTARTS_PER_WINDOW) {
      this.log.error(
        `slot ${slot}: ${recent.length} crashes in 5 min — giving up. ` +
        `Investigate (likely OOM / ulimit / cert). The pool will run with ` +
        `${this.workers.length} worker(s) until this slot is refilled manually.`,
      );
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s ceiling.
    const attempt = recent.length - 1;
    const delayMs = Math.min(30_000, 1_000 * Math.pow(2, attempt));
    this.log.warn(`slot ${slot}: restarting in ${delayMs}ms (attempt ${recent.length}/${MAX_RESTARTS_PER_WINDOW})`);

    setTimeout(() => {
      void this.spawnSlot(slot, rtcMinPort, rtcMaxPort, logLevel)
        .then(() => { this.restartTotals++; })
        .catch(e => {
          this.log.error(`slot ${slot}: respawn failed: ${(e as Error).message}`);
          // Recurse — `died` won't fire because the worker never
          // existed. Treat the spawn failure itself as a crash so
          // backoff applies.
          this.scheduleRestart(slot, rtcMinPort, rtcMaxPort, logLevel);
        });
    }, delayMs);
  }
}

/** Three crashes in a 5-min window stops the auto-restart loop. */
const MAX_RESTARTS_PER_WINDOW = 3;

/**
 * Router media codecs — mediasoup matches these against the client's
 * RTP capabilities during DTLS-SRTP setup. We advertise Opus for audio
 * and VP8 + H.264 for video (covers iOS/Android natively without
 * forcing a codec mismatch).
 */
const ROUTER_MEDIA_CODECS: MS.RtpCodecCapability[] = [
  {
    // ── Latency-tuned Opus (RFC 7587 fmtp params) ────────────────
    // The defaults libwebrtc negotiates give 32 kbps stereo with no
    // in-band FEC — on a lossy 4G link every dropped packet triggers
    // a NACK retransmit and the receiver's NetEq jitter buffer creeps
    // up to 300–500 ms of headroom, which the user feels as "echo".
    // The parameters below pin the negotiated encoder to a voice-only
    // operating point that targets ~200 ms one-way audio latency.
    //
    //   • minptime=10           — smallest packetization Opus allows
    //                             without exploding wire overhead;
    //                             keeps encode/queue delay at ~10 ms.
    //   • useinbandfec=1        — bundle FEC packets in-band so the
    //                             receiver can reconstruct one lost
    //                             packet without waiting for a NACK
    //                             round-trip.
    //   • usedtx=1              — discontinuous transmission. While the
    //                             talker is silent, drop bitrate to
    //                             ~5 kbps. Frees the modem uplink
    //                             queue so video frames don't sit
    //                             behind audio.
    //   • stereo=0              — voice calls are mono; halves encode
    //                             cost and wire bytes vs the libwebrtc
    //                             default. (channels stays at 2 so SDP
    //                             negotiation accepts both ends.)
    //   • maxaveragebitrate=32k — voice saturates here; matches the
    //                             32 kbps sender cap below.
    kind:                 'audio',
    mimeType:             'audio/opus',
    preferredPayloadType: 100,
    clockRate:            48000,
    channels:             2,
    parameters: {
      'minptime':          10,
      'useinbandfec':       1,
      'usedtx':             1,
      'stereo':             0,
      'maxaveragebitrate': 32000,
    },
  },
  {
    kind:                 'video',
    mimeType:             'video/VP8',
    preferredPayloadType: 101,
    clockRate:            90000,
    parameters:           {'x-google-start-bitrate': 1000},
  },
  {
    kind:                 'video',
    mimeType:             'video/H264',
    preferredPayloadType: 125,
    clockRate:            90000,
    parameters: {
      'packetization-mode':      1,
      'profile-level-id':        '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate':  1000,
    },
  },
];
