/**
 * Messenger-service environment configuration.
 *
 * Keep field names and defaults aligned with apps/auth-service/src/config/configuration.ts
 * so JWTs minted by auth-service verify cleanly here. In particular
 * `jwt.accessSecret` MUST read the SAME env var (JWT_ACCESS_SECRET).
 */
export default () => ({
  port:        parseInt(process.env['PORT'] ?? '3100', 10),
  nodeEnv:     process.env['NODE_ENV'] ?? 'development',

  ws: {
    /** Mount path for the gateway. Client connects to ws://host:3100/ws?token=... */
    path:            process.env['WS_PATH'] ?? '/ws',
    /** Heartbeat interval — server pings; client must pong within grace window. */
    heartbeatMs:     parseInt(process.env['WS_HEARTBEAT_MS']     ?? '30000', 10),
    // B-05 — this feeds socket.io `pingTimeout` (redis-io.adapter.ts). At
    // 10s it was too tight under variable Contabo/TURN latency: a pong that
    // arrived late got the socket reaped, kicking ALL participants of a live
    // call simultaneously (15/15 calls dropped in the 2026-06-08 QA session,
    // every call type). Raised to 25s to absorb latency/jitter spikes. NB:
    // this only addresses heartbeat-timeout drops — if the simultaneous
    // disconnects are a messenger-service process crash/restart instead, the
    // grace does nothing; that needs the server-side crash investigation +
    // PM2 watchdog noted in the QA report (requires host access).
    heartbeatGrace:  parseInt(process.env['WS_HEARTBEAT_GRACE']  ?? '25000', 10),
    /** Max bytes per frame — anything larger is dropped to prevent memory abuse. */
    maxPayloadBytes: parseInt(process.env['WS_MAX_PAYLOAD_BYTES'] ?? String(256 * 1024), 10),
    // OR-5/SRV-07 — socket.io connectionStateRecovery. OFF by default: the
    // SessionAwareRedisAdapter overrides broadcast() for every WS event and its
    // session buffer is per-process, so it is only correct on a single replica
    // (or behind sticky sessions). Enable on staging first.
    sessionRecovery: (process.env['WS_SESSION_RECOVERY'] ?? 'false') === 'true',
  },

  cors: {
    // Messaging-transport audit P0-2 — explicit CORS allowlist used by
    // BOTH the HTTP layer (main.ts) AND the socket.io gateway/adapter.
    // Without this the WS path defaulted to `origin: true` (reflect),
    // letting any malicious web page open a socket against the relay
    // using a stolen ops-console token. Same source-of-truth env var
    // as HTTP CORS so a single CORS_ORIGINS=... config controls both.
    origins: process.env['CORS_ORIGINS'] ?? '',
  },

  jwt: {
    accessSecret: process.env['JWT_ACCESS_SECRET'] ?? '',
    // Attachments audit P0-A5 — `JWT_ACTION_SECRET` must NOT silently
    // fall back to `JWT_ACCESS_SECRET`. Action tokens gate File Vault
    // MFA (biometric / TOTP capability proofs). Sharing the secret
    // means a leaked session-token secret immediately mints valid MFA
    // proofs, collapsing the "fresh challenge before download" gate
    // into ceremony. Empty here is a deliberate boot-failure signal
    // for `JwtService.verifyActionToken` (see logger.error at startup).
    actionSecret:   process.env['JWT_ACTION_SECRET'] ?? '',
    issuer:         process.env['JWT_ISSUER']          ?? 'auth-service',
    audience:       process.env['JWT_AUDIENCE']        ?? 'bravo-api',
    actionAudience: process.env['JWT_ACTION_AUDIENCE'] ?? 'bravo-action',
  },

  redis: {
    url: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
  },

  relay: {
    /** Signal-spec default: envelopes live on the relay at most 30 days. */
    dwellSeconds:     parseInt(process.env['RELAY_DWELL_SECONDS']     ?? String(30 * 24 * 3600), 10),
    /** Max pull page size (client-side cap). */
    maxPullLimit:     parseInt(process.env['RELAY_MAX_PULL_LIMIT']    ?? '100', 10),
    /**
     * Reject any outer-sealed body larger than this (base64-encoded).
     * Inner libsignal ciphertext is bounded at 256 KB and the Sealed
     * Sender v2 outer wrap adds 45 B header + 16 B GCM tag, so 700 KB
     * raw gives ~2× headroom after base64 expansion without inviting
     * memory abuse.
     */
    maxCiphertextBytes: parseInt(process.env['RELAY_MAX_CIPHERTEXT_BYTES'] ?? String(700 * 1024), 10),
    // Messaging-transport audit P1-4 — possession-proof ack tokens
    // (P0-N9) are mandatory by default. Rollout-era clients without
    // tokens are now rejected at ack time. Operators can flip back
    // to `false` via RELAY_REQUIRE_ACK_TOKEN=false during emergency
    // rollback, but should never run that way steady-state.
    requireAckToken: (process.env['RELAY_REQUIRE_ACK_TOKEN'] ?? 'true') !== 'false',
    /**
     * Audit P0-7 — per-recipient pending-queue ceiling. A single
     * malicious submitter must not be able to torch a recipient's
     * inbox by flooding `pending:{user}:{device}`. 10_000 is generous
     * for steady-state load but tight enough to wall off attackers.
     * Enforced atomically via Lua in `EnvelopeStore.put`.
     */
    maxPendingPerDevice: parseInt(process.env['RELAY_MAX_PENDING_PER_DEVICE'] ?? '10000', 10),
  },

  vault: {
    /** Presigned URL TTL for vault downloads — much shorter than M6 media (spec: 60s). */
    presignTtlSeconds: parseInt(process.env['VAULT_PRESIGN_TTL_SECONDS'] ?? '60', 10),
    /** Max age of an MFA action token before we reject as "not fresh enough". */
    mfaMaxAgeSec:      parseInt(process.env['VAULT_MFA_MAX_AGE_SEC']     ?? '300', 10),
    /** Purposes accepted as proof of MFA. Clients obtain these from auth-service. */
    mfaPurposes:       (process.env['VAULT_MFA_PURPOSES'] ?? 'vault-access,biometric-verified,totp-verified').split(','),
  },

  turn: {
    /**
     * coturn `--use-auth-secret` shared static secret. Clients never
     * see it. Time-limited usernames are HMAC-SHA1-signed with this
     * secret; coturn verifies against the same. Rotate by flipping
     * env + coturn config together (brief service blip acceptable
     * since WebRTC ICE re-gathers on failure).
     */
    staticAuthSecret: process.env['TURN_STATIC_AUTH_SECRET'] ?? '',
    /** Credential TTL in seconds. 24h per BE-4.2 WBS. */
    ttlSeconds:       parseInt(process.env['TURN_TTL_SECONDS'] ?? '86400', 10),
    /**
     * coturn URLs returned verbatim in the credential response.
     *
     * Default ships BOTH transports (UDP + TCP) for the staging coturn
     * on 94.136.184.52. UDP is the fast path; TCP is the lifeline for
     * networks (corporate WiFi, hotel APs, mobile-data CGNAT) that
     * block outbound UDP to non-443 ports. Without a TCP entry, every
     * cross-NAT call from a UDP-restricted network silently falls to
     * "host candidates only" and fails as soon as the peers aren't on
     * the same LAN. The previous default pointed at unrouted
     * `turn-{mumbai,london}.bravosecure.com` hostnames — DNS NXDOMAIN
     * → no relay candidate → cross-WiFi calls dead in the water.
     *
     * Override via `TURN_URLS` for prod / per-region deployments.
     */
    urls: (process.env['TURN_URLS'] ??
      // udp first (fastest), plain tcp fallback for UDP-blocked networks,
      // turns: TLS fallback for networks that block all non-443/non-TLS
      // outbound (corporate proxies, hotel captive Wi-Fi). Coturn already
      // serves --tls-listening-port=5349 with the sslip.io cert.
      'turn:94.136.184.52:3478?transport=udp,turn:94.136.184.52:3478?transport=tcp,turns:94.136.184.52:5349?transport=tcp'
    ).split(',').map(u => u.trim()).filter(Boolean),
    /**
     * Public STUN URLs prepended to the TURN URL list in the credential
     * response. STUN is auth-free and lets the client gather server-
     * reflexive candidates as a complement to TURN — many same-ISP NAT
     * pairs connect via srflx and never need to hit the relay, saving
     * coturn bandwidth. Also acts as a graceful degradation path: if
     * the configured TURN URL is bricked (typo, DNS gone, coturn down),
     * the client at least gets srflx and a chunk of cross-NAT calls
     * still complete instead of every call ending in "secure connection
     * could not be established".
     *
     * Per W3C spec, STUN URLs in the same iceServers entry as TURN URLs
     * simply ignore the username/credential, so we can ship them in one
     * mixed list without a separate response field.
     */
    stunUrls: (process.env['TURN_STUN_URLS'] ?? 'stun:stun.l.google.com:19302')
      .split(',').map(u => u.trim()).filter(Boolean),
  },

  sfu: {
    /**
     * mediasoup Worker pool size. Defaults to one Worker per CPU core
     * (mediasoup's recommended scaling unit — each Worker is a single
     * C++ process pinned to a core). Override via SFU_WORKERS for
     * deployments where you want to leave headroom for the Node.js
     * main thread.
     */
    workerCount:   parseInt(process.env['SFU_WORKERS'] ?? '0', 10) || undefined,
    /** Worker log level. 'warn' in prod; 'debug' to chase media issues. */
    workerLogLevel: (process.env['SFU_WORKER_LOG_LEVEL'] ?? 'warn') as 'debug' | 'warn' | 'error' | 'none',
    /**
     * UDP/TCP port range mediasoup binds for RTC. Must be opened on
     * the firewall. mediasoup default is 10000-59999; we tighten to
     * 40000-49999 to match the security group rules in the infra plan.
     */
    rtcMinPort:    parseInt(process.env['SFU_RTC_MIN_PORT'] ?? '40000', 10),
    rtcMaxPort:    parseInt(process.env['SFU_RTC_MAX_PORT'] ?? '49999', 10),
    /**
     * Listen IP for WebRtcTransport. '0.0.0.0' binds all interfaces.
     * On AWS / containers behind NAT, set ANNOUNCED_IP to the public
     * IP so ICE candidates are reachable from clients.
     */
    listenIp:      process.env['SFU_LISTEN_IP']   ?? '0.0.0.0',
    announcedIp:   process.env['SFU_ANNOUNCED_IP'] || undefined,
    /**
     * Initial outgoing bitrate per producer transport in bits/sec.
     *
     * Tuned down from 1 Mbps → 300 kbps for latency: starting the
     * transport at 1 Mbps fills the client's modem uplink queue with
     * video packets before TWCC has measured the real link capacity,
     * and audio sits behind that queue → audible delay at call start.
     * 300 kbps is below any usable 4G uplink (typical 1–10 Mbps), so
     * the link is never saturated; mediasoup's transport-cc ramps the
     * video bitrate up within ~1s once it sees clean acks.
     */
    initialBitrate: parseInt(process.env['SFU_INITIAL_BITRATE'] ?? String(300_000), 10),
    /**
     * Audit P0-C2 — HMAC secret for per-recipient SFU room-access tokens.
     * Without this, knowing a `roomId` is sufficient to land on the SFU
     * via `sfu.join`. Required in production; falsy values cause
     * RoomTokenService to throw at first use (surfaced loud rather than
     * silently admitting every join). Generate via:
     *   `openssl rand -base64 48`
     */
    roomTokenSecret: process.env['SFU_ROOM_TOKEN_SECRET'] ?? '',
  },

  backup: {
    /**
     * Supabase project URL + service-role key. Service-role bypasses
     * RLS, which we need because our backup tables intentionally have
     * RLS off (auth lives in this layer; the anon role is denied
     * directly via REVOKE in the migration).
     */
    supabaseUrl:           process.env['SUPABASE_URL'] ?? '',
    supabaseServiceRoleKey: process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    /**
     * Brute-force throttle on identity backup unwrap. After this many
     * consecutive wrong-password attempts the row locks for
     * `lockoutSeconds` and POST /backup/identity/verify returns 423.
     * Defaults match WhatsApp's HSM-backed throttle (5 attempts, 1h).
     */
    maxFailedAttempts:     parseInt(process.env['BACKUP_MAX_FAILED_ATTEMPTS'] ?? '5', 10),
    lockoutSeconds:        parseInt(process.env['BACKUP_LOCKOUT_SECONDS']     ?? '3600', 10),
    /**
     * Max rows accepted in a single POST /backup/messages batch.
     * The client mirrors in batches of ~50; this is the upper bound.
     */
    maxMessageBatchSize:   parseInt(process.env['BACKUP_MAX_MESSAGE_BATCH']   ?? '500', 10),
    /**
     * H-11 — per-user ceiling on rows in messages_backup /
     * conversation_backups. Neither table has a retention sweep yet
     * (Phase-2), so this is the only bound on a single account's
     * footprint. Enforced best-effort in putMessages/putConversations;
     * a failing count query never blocks a legitimate write. Generous
     * default (500k message rows ≈ years of an active account).
     */
    maxMessageRowsPerUser: parseInt(process.env['BACKUP_MAX_MESSAGE_ROWS_PER_USER'] ?? '500000', 10),
    /**
     * P0-1 verify protocol TTLs. The nonce covers "type password +
     * argon2id derive" (generous); the token is the short window from a
     * successful /verify to the /bundle GET.
     */
    verifyNonceTtlSec:     parseInt(process.env['BACKUP_VERIFY_NONCE_TTL_SEC'] ?? '300', 10),
    verifyTokenTtlSec:     parseInt(process.env['BACKUP_VERIFY_TOKEN_TTL_SEC'] ?? '120', 10),
  },

  media: {
    /** S3-compatible endpoint. For R2: https://<accountid>.r2.cloudflarestorage.com */
    endpoint:        process.env['MEDIA_S3_ENDPOINT'] ?? '',
    /** Bucket for encrypted attachment blobs. */
    bucket:          process.env['MEDIA_S3_BUCKET']   ?? 'bravo-messenger-media',
    /** Region — R2 expects "auto"; AWS expects a real region. */
    region:          process.env['MEDIA_S3_REGION']   ?? 'auto',
    accessKeyId:     process.env['MEDIA_S3_ACCESS_KEY_ID']     ?? '',
    secretAccessKey: process.env['MEDIA_S3_SECRET_ACCESS_KEY'] ?? '',
    /** Presigned URL TTL in seconds. Short by design — clients request right before use. */
    presignTtlSeconds: parseInt(process.env['MEDIA_PRESIGN_TTL_SECONDS'] ?? '300', 10),
    /** Max allowed attachment size (after encryption). 50 MB default. */
    maxUploadBytes:    parseInt(process.env['MEDIA_MAX_UPLOAD_BYTES']    ?? String(50 * 1024 * 1024), 10),
    /**
     * Audit Rev2 MED-01 — recipient-grant enforcement. DEFAULTS TRUE
     * (deny any download without a positive grant). The old default read
     * `process.env.X === 'true'`, so an UNSET var failed OPEN: a fresh
     * environment, a rebuild that dropped the var, or a local stack admitted
     * any authenticated caller holding an object key. Fails CLOSED now — only
     * the literal 'false' reopens the (historical) lax rollout window, and any
     * typo stays strict. The owner grant is stamped at createUploadUrl, so the
     * uploader's own post-PUT length probe still passes under strict mode.
     */
    requireRecipientGrant: (process.env['MEDIA_REQUIRE_RECIPIENT_GRANT'] ?? 'true') !== 'false',
  },
});
