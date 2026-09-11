#!/usr/bin/env bash
# sync-turn-certs.sh — copy Caddy's Let's Encrypt cert for turn.bravosecure.cloud
# into the directory coturn mounts, and restart coturn if it changed.
# Run once before the first `docker compose up`, and from cron for renewals:
#     17 4 * * * /opt/bravo/deploy/production/sync-turn-certs.sh
# coturn needs a real certificate for TURN-over-TLS (5349), the transport that
# gets calls through networks blocking UDP. Certs renew every ~60 days; without
# this, TLS-TURN silently expires and only the hardest calls start failing.
set -euo pipefail
HOST=turn.bravosecure.cloud
SRC=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$HOST
DST="$(dirname "${BASH_SOURCE[0]}")/secrets/coturn-certs"
mkdir -p "$DST"
[[ -f "$SRC/$HOST.crt" && -f "$SRC/$HOST.key" ]] || { echo "no cert yet at $SRC — has Caddy issued $HOST? (journalctl -u caddy)"; exit 1; }
if cmp -s "$SRC/$HOST.crt" "$DST/$HOST.crt" 2>/dev/null; then
  echo "coturn cert unchanged"; exit 0
fi
install -m 644 "$SRC/$HOST.crt" "$DST/$HOST.crt"
install -m 640 "$SRC/$HOST.key" "$DST/$HOST.key"
echo "coturn cert updated"
docker restart bravo-coturn >/dev/null 2>&1 && echo "coturn restarted" || echo "coturn not running yet — it will pick the cert up on first start"
