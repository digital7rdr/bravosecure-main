#!/usr/bin/env bash
#
# bootstrap.sh — prepare a fresh Ubuntu box to run the Bravo production stack.
# Run as root on 31.97.126.211:  bash deploy/production/bootstrap.sh
#
# Idempotent: every step checks before acting, so re-running is safe.
# It deliberately does NOT touch SSH auth — see the note at the end. Locking
# yourself out of a box you cannot console into is worse than a day of root
# login, and that decision should be made deliberately, not by a script.
set -euo pipefail

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run as root"
. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
[[ "${ID:-}" == "ubuntu" || "${ID:-}" == "debian" ]] || warn "untested on ${ID:-unknown}; expected ubuntu/debian"

say "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw git jq openssl debian-keyring debian-archive-keyring apt-transport-https
ok "base packages"

say "Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/$ID/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker --version >/dev/null || die "docker install failed"
ok "$(docker --version)"
ok "$(docker compose version)"

say "Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
ok "$(caddy version)"

say "Node.js 20 (make-env.sh mints the sender-cert keypair with it)"
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
ok "$(node -v)"

say "Firewall"
# Open ONLY what Bravo needs. Everything else — including the app ports —
# stays shut; the containers bind 127.0.0.1 and Caddy is the sole ingress.
ufw allow 22/tcp        comment 'ssh'          >/dev/null
ufw allow 80/tcp        comment 'http/acme'    >/dev/null
ufw allow 443/tcp       comment 'https'        >/dev/null
ufw allow 3478/tcp      comment 'turn tcp'     >/dev/null
ufw allow 3478/udp      comment 'turn udp'     >/dev/null
ufw allow 5349/tcp      comment 'turns tls'    >/dev/null
ufw allow 49160:49200/udp comment 'turn relay' >/dev/null
ufw --force enable >/dev/null
ok "ufw active — $(ufw status | grep -c ALLOW) rules"

say "DNS pre-flight"
# Caddy cannot issue certs for a name that does not resolve here yet, and a
# failed ACME attempt counts against Let's Encrypt's rate limit. Check first.
missing=0
for h in auth relay ops media turn api; do
  got="$(getent hosts "$h.bravosecure.cloud" | awk '{print $1}' | head -1 || true)"
  if [[ "$got" == "31.97.126.211" ]]; then
    ok "$h.bravosecure.cloud → $got"
  else
    warn "$h.bravosecure.cloud → ${got:-NXDOMAIN} (expected 31.97.126.211)"
    missing=$((missing + 1))
  fi
done
[[ "$missing" -eq 0 ]] || warn "$missing record(s) not resolving yet — add them and wait before reloading Caddy"

say "Supabase (self-hosted)"
# Supabase is AGPL open source; we run its official compose unmodified so it
# stays upgradeable, and join our services to its network from ours.
if [[ ! -d /opt/supabase ]]; then
  git clone --depth 1 https://github.com/supabase/supabase /opt/supabase-src
  mkdir -p /opt/supabase
  # `/.` not `/*` — a shell glob skips dotfiles, and .env.example is one.
  cp -r /opt/supabase-src/docker/. /opt/supabase/
  ok "supabase docker/ staged at /opt/supabase — setup-supabase.sh configures and starts it"
else
  ok "/opt/supabase already present — leaving it alone"
fi

say "Directories"
mkdir -p /opt/bravo/deploy/production/secrets/coturn-certs
chmod 700 /opt/bravo/deploy/production/secrets
ok "/opt/bravo"

say "Done"
cat <<'NEXT'
  Next, in order:
    1. bash deploy/production/setup-supabase.sh      (secrets, loopback ports, start, migrate)
    2. cd deploy/production && ./make-env.sh           (reads the Supabase creds itself)
       Fill the ONE remaining placeholder: NEXT_PUBLIC_MAPBOX_TOKEN in .env
    3. Drop firebase-service-account.json into deploy/production/secrets/.
    4. cp Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
       Watch certs issue:  journalctl -u caddy -f
    5. docker compose -f docker-compose.prod.yml up -d --build

  NOT DONE HERE, on purpose — SSH hardening. Before disabling root login,
  confirm you can log in as a non-root user with a key IN A SECOND SESSION,
  keeping this one open. Then:
      adduser bravo && usermod -aG docker,sudo bravo
      mkdir -p /home/bravo/.ssh && cp ~/.ssh/authorized_keys /home/bravo/.ssh/
      chown -R bravo:bravo /home/bravo/.ssh && chmod 700 /home/bravo/.ssh
      # verify the new session works, THEN:
      sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/;s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
      systemctl reload ssh
NEXT
